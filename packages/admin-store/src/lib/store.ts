import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  isPermission,
  PermissionError,
  type Permission,
} from './permissions.js';
import {
  adminPermissions,
  adminServers,
  admins,
  auditLog,
  knownPlayers,
  playerNotes,
  reports,
  servers,
  serverSnapshots,
  settings,
  telegramUsers,
} from './schema.js';
import { SecretBox } from './secrets.js';
import type {
  AddPlayerNoteInput,
  Admin,
  AdminStore,
  AuditLogEntry,
  AuditLogFilter,
  ClaimOwnerResult,
  KnownPlayer,
  PlayerNote,
  PlayerNoteFilter,
  PlayerNoteKind,
  RecordAuditLogInput,
  RecordReportInput,
  RecordSnapshotInput,
  Report,
  ReportFilter,
  ReportStatus,
  SaveKnownPlayerInput,
  ServerConfig,
  ServerSnapshot,
  TelegramUser,
  UpsertServerInput,
} from './types.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/** drizzle-orm wraps the raw pg error (which carries `.code`) as `.cause`, not on itself. */
type AdminRow = {
  telegramId: number;
  isOwner: boolean;
  addedBy: number | null;
  addedAt: Date;
  username: string | null;
  firstName: string | null;
};

async function replacePermissions(
  tx: Pick<NodePgDatabase, 'delete' | 'insert'>,
  telegramId: number,
  permissions: readonly Permission[],
): Promise<void> {
  const unique = [...new Set(permissions)];
  for (const permission of unique) {
    if (!isPermission(permission)) {
      throw new PermissionError(`Unknown permission: ${permission}`);
    }
  }
  await tx
    .delete(adminPermissions)
    .where(eq(adminPermissions.telegramId, telegramId));
  if (unique.length === 0) {
    return;
  }
  await tx
    .insert(adminPermissions)
    .values(unique.map((permission) => ({ telegramId, permission })));
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code =
    (error as { code?: string }).code ??
    (error as { cause?: { code?: string } }).cause?.code;
  return code === POSTGRES_UNIQUE_VIOLATION;
}

/** Admin rows with their remembered Telegram names, if any (left join — names are optional). */
const ADMIN_COLUMNS = {
  telegramId: admins.telegramId,
  isOwner: admins.isOwner,
  addedBy: admins.addedBy,
  addedAt: admins.addedAt,
  username: telegramUsers.username,
  firstName: telegramUsers.firstName,
};

/** `%`, `_` and `\` from a user's search box are literal text, not wildcards. */
function contains(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

const AUDIT_LOG_COLUMNS = {
  id: auditLog.id,
  actorTelegramId: auditLog.actorTelegramId,
  action: auditLog.action,
  target: auditLog.target,
  serverAlias: auditLog.serverAlias,
  reason: auditLog.reason,
  source: auditLog.source,
  detailJson: auditLog.detailJson,
  createdAt: auditLog.createdAt,
  actorUsername: telegramUsers.username,
  actorFirstName: telegramUsers.firstName,
};

export class DrizzleAdminStore implements AdminStore {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase;
  private readonly secretBox: SecretBox;

  constructor(connectionString: string, secretsEncryptionKey: string) {
    this.pool = new Pool({ connectionString });
    this.db = drizzle(this.pool);
    this.secretBox = new SecretBox(secretsEncryptionKey);
  }

  async getAdmin(telegramId: number): Promise<Admin | undefined> {
    const [row] = await this.selectAdmins().where(
      eq(admins.telegramId, telegramId),
    );
    if (!row) {
      return undefined;
    }
    const [admin] = await this.withPermissions([row]);
    return admin;
  }

  async claimOwner(telegramId: number): Promise<ClaimOwnerResult> {
    try {
      await this.db
        .insert(admins)
        .values({ telegramId, isOwner: true, addedBy: null });
      return 'claimed';
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'already-claimed';
      }
      throw error;
    }
  }

  async addAdmin(
    telegramId: number,
    permissions: readonly Permission[],
    addedBy: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(admins).values({ telegramId, isOwner: false, addedBy });
      await replacePermissions(tx, telegramId, permissions);
    });
  }

  async removeAdmin(telegramId: number): Promise<void> {
    await this.db.delete(admins).where(eq(admins.telegramId, telegramId));
  }

  async setPermissions(
    telegramId: number,
    permissions: readonly Permission[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await replacePermissions(tx, telegramId, permissions);
    });
  }

  async listAdmins(): Promise<Admin[]> {
    return this.withPermissions(await this.selectAdmins());
  }

  async saveTelegramUser(user: TelegramUser): Promise<void> {
    const { telegramId, username, firstName } = user;
    await this.db
      .insert(telegramUsers)
      .values({ telegramId, username, firstName })
      .onConflictDoUpdate({
        target: telegramUsers.telegramId,
        set: { username, firstName, updatedAt: new Date() },
      });
  }

  async upsertServer(input: UpsertServerInput): Promise<void> {
    const rconPasswordEncrypted = this.secretBox.encrypt(input.rconPassword);
    await this.db
      .insert(servers)
      .values({
        alias: input.alias,
        rconHost: input.rconHost,
        rconPort: input.rconPort,
        rconPasswordEncrypted,
        logSourceConfig: input.logSourceConfig ?? null,
      })
      .onConflictDoUpdate({
        target: servers.alias,
        set: {
          rconHost: input.rconHost,
          rconPort: input.rconPort,
          rconPasswordEncrypted,
          ...(input.logSourceConfig === undefined
            ? {}
            : { logSourceConfig: input.logSourceConfig }),
        },
      });
  }

  async setServerLogPath(alias: string, path: string | null): Promise<void> {
    await this.db
      .update(servers)
      .set({ logSourceConfig: path })
      .where(eq(servers.alias, alias));
  }

  async getServer(alias: string): Promise<ServerConfig | undefined> {
    const [row] = await this.db
      .select()
      .from(servers)
      .where(eq(servers.alias, alias));
    return row ? this.toServerConfig(row) : undefined;
  }

  async listServers(): Promise<ServerConfig[]> {
    const rows = await this.db.select().from(servers);
    return rows.map((row) => this.toServerConfig(row));
  }

  async bindServerToChat(alias: string, chatId: number): Promise<void> {
    await this.db
      .update(servers)
      .set({ boundTelegramChatId: chatId })
      .where(eq(servers.alias, alias));
  }

  async getServerForChat(chatId: number): Promise<ServerConfig | undefined> {
    const [row] = await this.db
      .select()
      .from(servers)
      .where(eq(servers.boundTelegramChatId, chatId));
    return row ? this.toServerConfig(row) : undefined;
  }

  async removeServer(alias: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.delete(adminServers).where(eq(adminServers.serverAlias, alias));
      const deleted = await tx
        .delete(servers)
        .where(eq(servers.alias, alias))
        .returning({ alias: servers.alias });
      return deleted.length > 0;
    });
  }

  async setDefaultServer(alias: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ alias: servers.alias })
        .from(servers)
        .where(eq(servers.alias, alias));
      if (!row) {
        return false;
      }
      // Clear first: servers_one_default_idx allows only one true row at any moment.
      await tx
        .update(servers)
        .set({ isDefault: false })
        .where(eq(servers.isDefault, true));
      await tx
        .update(servers)
        .set({ isDefault: true })
        .where(eq(servers.alias, alias));
      return true;
    });
  }

  async getDefaultServer(): Promise<ServerConfig | undefined> {
    const [row] = await this.db
      .select()
      .from(servers)
      .where(eq(servers.isDefault, true));
    return row ? this.toServerConfig(row) : undefined;
  }

  async getSetting(key: string): Promise<unknown> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key));
    return row?.value;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }

  async recordAuditLog(entry: RecordAuditLogInput): Promise<void> {
    await this.db.insert(auditLog).values({
      actorTelegramId: entry.actorTelegramId,
      action: entry.action,
      target: entry.target ?? null,
      serverAlias: entry.serverAlias ?? null,
      reason: entry.reason ?? null,
      source: entry.source,
      detailJson: entry.detailJson ?? null,
    });
  }

  async listAuditLog(limit: number): Promise<AuditLogEntry[]> {
    return this.selectAuditLog().orderBy(desc(auditLog.createdAt)).limit(limit);
  }

  async listAuditLogForTarget(
    serverAlias: string,
    targetName: string,
    limit: number,
  ): Promise<AuditLogEntry[]> {
    return this.selectAuditLog()
      .where(
        and(
          eq(auditLog.serverAlias, serverAlias),
          ilike(auditLog.target, targetName),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
  }

  async searchAuditLog(filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    const conditions: (SQL | undefined)[] = [
      filter.query
        ? or(
            ilike(auditLog.target, contains(filter.query)),
            ilike(auditLog.reason, contains(filter.query)),
          )
        : undefined,
      filter.action ? eq(auditLog.action, filter.action) : undefined,
      filter.actorTelegramId === undefined
        ? undefined
        : eq(auditLog.actorTelegramId, filter.actorTelegramId),
      filter.serverAlias
        ? eq(auditLog.serverAlias, filter.serverAlias)
        : undefined,
      filter.source ? eq(auditLog.source, filter.source) : undefined,
      filter.since ? gte(auditLog.createdAt, filter.since) : undefined,
      filter.until ? lte(auditLog.createdAt, filter.until) : undefined,
    ];
    return this.selectAuditLog()
      .where(and(...conditions))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(filter.limit)
      .offset(filter.offset ?? 0);
  }

  async listAuditActions(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ action: auditLog.action })
      .from(auditLog)
      .orderBy(asc(auditLog.action));
    return rows.map((row) => row.action);
  }

  async recordReport(input: RecordReportInput): Promise<Report> {
    const reason = input.reason ?? null;
    return this.db.transaction(async (tx) => {
      const [open] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(
            eq(reports.status, 'open'),
            eq(reports.serverAlias, input.serverAlias),
            eq(reports.reporterName, input.reporterName),
            sql`lower(${reports.targetName}) = lower(${input.targetName})`,
          ),
        )
        .for('update')
        .limit(1);
      if (open) {
        const [updated] = await tx
          .update(reports)
          .set({
            count: sql`${reports.count} + 1`,
            lastReportedAt: new Date(),
            ...(reason === null ? {} : { reason }),
          })
          .where(eq(reports.id, open.id))
          .returning();
        return updated as Report;
      }
      const [created] = await tx
        .insert(reports)
        .values({
          serverAlias: input.serverAlias,
          reporterName: input.reporterName,
          reporterGuid: input.reporterGuid ?? null,
          targetName: input.targetName,
          reason,
        })
        .returning();
      return created as Report;
    });
  }

  async getReport(id: number): Promise<Report | undefined> {
    const [row] = await this.db
      .select()
      .from(reports)
      .where(eq(reports.id, id));
    return row;
  }

  async searchReports(filter: ReportFilter): Promise<Report[]> {
    return this.db
      .select()
      .from(reports)
      .where(
        and(
          filter.resolved
            ? ne(reports.status, 'open')
            : eq(reports.status, 'open'),
          filter.serverAlias
            ? eq(reports.serverAlias, filter.serverAlias)
            : undefined,
        ),
      )
      .orderBy(
        desc(filter.resolved ? reports.resolvedAt : reports.lastReportedAt),
        desc(reports.id),
      )
      .limit(filter.limit)
      .offset(filter.offset ?? 0);
  }

  async countOpenReports(): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(reports)
      .where(eq(reports.status, 'open'));
    return row?.value ?? 0;
  }

  async resolveReport(
    id: number,
    resolution: {
      status: Exclude<ReportStatus, 'open'>;
      resolvedBy: number;
      outcome?: string | null;
    },
  ): Promise<Report | undefined> {
    const [row] = await this.db
      .update(reports)
      .set({
        status: resolution.status,
        resolvedBy: resolution.resolvedBy,
        resolvedAt: new Date(),
        outcome: resolution.outcome ?? null,
      })
      // Only an open one: two admins acting at once must not overwrite each other.
      .where(and(eq(reports.id, id), eq(reports.status, 'open')))
      .returning();
    return row;
  }

  async addPlayerNote(input: AddPlayerNoteInput): Promise<PlayerNote> {
    const [row] = await this.db.insert(playerNotes).values(input).returning();
    return row as PlayerNote;
  }

  async getPlayerNote(id: number): Promise<PlayerNote | undefined> {
    const [row] = await this.db
      .select()
      .from(playerNotes)
      .where(eq(playerNotes.id, id));
    return row;
  }

  async searchPlayerNotes(filter: PlayerNoteFilter): Promise<PlayerNote[]> {
    return this.db
      .select()
      .from(playerNotes)
      .where(
        and(
          filter.query
            ? or(
                ilike(playerNotes.value, contains(filter.query)),
                ilike(playerNotes.note, contains(filter.query)),
              )
            : undefined,
          filter.watchOnly ? eq(playerNotes.watch, true) : undefined,
        ),
      )
      .orderBy(desc(playerNotes.updatedAt), desc(playerNotes.id))
      .limit(filter.limit)
      .offset(filter.offset ?? 0);
  }

  async findPlayerNotes(
    identities: { kind: PlayerNoteKind; value: string }[],
  ): Promise<PlayerNote[]> {
    if (identities.length === 0) {
      return [];
    }
    return this.db
      .select()
      .from(playerNotes)
      .where(
        or(
          ...identities.map(({ kind, value }) =>
            and(eq(playerNotes.kind, kind), eq(playerNotes.value, value)),
          ),
        ),
      )
      .orderBy(desc(playerNotes.updatedAt), desc(playerNotes.id));
  }

  async updatePlayerNote(
    id: number,
    changes: { note?: string; watch?: boolean },
  ): Promise<PlayerNote | undefined> {
    const [row] = await this.db
      .update(playerNotes)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(playerNotes.id, id))
      .returning();
    return row;
  }

  async deletePlayerNote(id: number): Promise<boolean> {
    const deleted = await this.db
      .delete(playerNotes)
      .where(eq(playerNotes.id, id))
      .returning({ id: playerNotes.id });
    return deleted.length > 0;
  }

  async listKnownPlayers(): Promise<KnownPlayer[]> {
    return this.db.select().from(knownPlayers).orderBy(asc(knownPlayers.name));
  }

  async saveKnownPlayer(input: SaveKnownPlayerInput): Promise<KnownPlayer> {
    const note = input.note ?? null;
    const [row] = await this.db
      .insert(knownPlayers)
      .values({ ...input, note })
      .onConflictDoUpdate({
        target: knownPlayers.name,
        set: {
          display: input.display,
          asns: input.asns,
          guids: input.guids,
          note,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row as KnownPlayer;
  }

  async deleteKnownPlayer(name: string): Promise<boolean> {
    const deleted = await this.db
      .delete(knownPlayers)
      .where(eq(knownPlayers.name, name))
      .returning({ id: knownPlayers.id });
    return deleted.length > 0;
  }

  async recordServerSnapshot(input: RecordSnapshotInput): Promise<void> {
    await this.db.insert(serverSnapshots).values(input);
  }

  async listServerSnapshots(
    serverAlias: string,
    since: Date,
  ): Promise<ServerSnapshot[]> {
    return this.db
      .select({
        serverAlias: serverSnapshots.serverAlias,
        at: serverSnapshots.at,
        online: serverSnapshots.online,
        playerCount: serverSnapshots.playerCount,
        maxClients: serverSnapshots.maxClients,
        map: serverSnapshots.map,
        gametype: serverSnapshots.gametype,
      })
      .from(serverSnapshots)
      .where(
        and(
          eq(serverSnapshots.serverAlias, serverAlias),
          gte(serverSnapshots.at, since),
        ),
      )
      .orderBy(asc(serverSnapshots.at));
  }

  async pruneServerSnapshots(before: Date): Promise<void> {
    await this.db.delete(serverSnapshots).where(lt(serverSnapshots.at, before));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async withPermissions(rows: AdminRow[]): Promise<Admin[]> {
    if (rows.length === 0) {
      return [];
    }
    const grants = await this.db
      .select({
        telegramId: adminPermissions.telegramId,
        permission: adminPermissions.permission,
      })
      .from(adminPermissions)
      .where(
        inArray(
          adminPermissions.telegramId,
          rows.map((row) => row.telegramId),
        ),
      );
    const byId = new Map<number, Permission[]>();
    for (const grant of grants) {
      if (!isPermission(grant.permission)) {
        continue;
      }
      const list = byId.get(grant.telegramId) ?? [];
      list.push(grant.permission);
      byId.set(grant.telegramId, list);
    }
    return rows.map((row) => ({
      ...row,
      permissions: row.isOwner ? [] : (byId.get(row.telegramId) ?? []),
    }));
  }

  private selectAdmins() {
    return this.db
      .select(ADMIN_COLUMNS)
      .from(admins)
      .leftJoin(telegramUsers, eq(telegramUsers.telegramId, admins.telegramId))
      .$dynamic();
  }

  private selectAuditLog() {
    return this.db
      .select(AUDIT_LOG_COLUMNS)
      .from(auditLog)
      .leftJoin(
        telegramUsers,
        eq(telegramUsers.telegramId, auditLog.actorTelegramId),
      )
      .$dynamic();
  }

  private toServerConfig(row: typeof servers.$inferSelect): ServerConfig {
    return {
      alias: row.alias,
      rconHost: row.rconHost,
      rconPort: row.rconPort,
      rconPassword: this.secretBox.decrypt(row.rconPasswordEncrypted),
      logSourceConfig: row.logSourceConfig,
      boundTelegramChatId: row.boundTelegramChatId,
      isDefault: row.isDefault,
    };
  }
}

export function createAdminStore(
  connectionString: string,
  secretsEncryptionKey: string,
): AdminStore {
  return new DrizzleAdminStore(connectionString, secretsEncryptionKey);
}
