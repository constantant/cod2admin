import { and, desc, eq, ilike } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { adminServers, admins, auditLog, servers, settings, telegramUsers } from './schema.js';
import { SecretBox } from './secrets.js';
import type {
  Admin,
  AdminRole,
  AdminStore,
  AuditLogEntry,
  ClaimOwnerResult,
  RecordAuditLogInput,
  ServerConfig,
  TelegramUser,
  UpsertServerInput,
} from './types.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

/** drizzle-orm wraps the raw pg error (which carries `.code`) as `.cause`, not on itself. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  return code === POSTGRES_UNIQUE_VIOLATION;
}

/** Admin rows with their remembered Telegram names, if any (left join — names are optional). */
const ADMIN_COLUMNS = {
  telegramId: admins.telegramId,
  role: admins.role,
  addedBy: admins.addedBy,
  addedAt: admins.addedAt,
  username: telegramUsers.username,
  firstName: telegramUsers.firstName,
};

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
    const [row] = await this.selectAdmins().where(eq(admins.telegramId, telegramId));
    return row;
  }

  async claimOwner(telegramId: number): Promise<ClaimOwnerResult> {
    try {
      await this.db.insert(admins).values({ telegramId, role: 'owner', addedBy: null });
      return 'claimed';
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'already-claimed';
      }
      throw error;
    }
  }

  async addAdmin(telegramId: number, role: AdminRole, addedBy: number): Promise<void> {
    await this.db.insert(admins).values({ telegramId, role, addedBy });
  }

  async removeAdmin(telegramId: number): Promise<void> {
    await this.db.delete(admins).where(eq(admins.telegramId, telegramId));
  }

  async setRole(telegramId: number, role: AdminRole): Promise<void> {
    await this.db.update(admins).set({ role }).where(eq(admins.telegramId, telegramId));
  }

  async listAdmins(): Promise<Admin[]> {
    return this.selectAdmins();
  }

  async saveTelegramUser(user: TelegramUser): Promise<void> {
    const { telegramId, username, firstName } = user;
    await this.db
      .insert(telegramUsers)
      .values({ telegramId, username, firstName })
      .onConflictDoUpdate({ target: telegramUsers.telegramId, set: { username, firstName, updatedAt: new Date() } });
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
          logSourceConfig: input.logSourceConfig ?? null,
        },
      });
  }

  async getServer(alias: string): Promise<ServerConfig | undefined> {
    const [row] = await this.db.select().from(servers).where(eq(servers.alias, alias));
    return row ? this.toServerConfig(row) : undefined;
  }

  async listServers(): Promise<ServerConfig[]> {
    const rows = await this.db.select().from(servers);
    return rows.map((row) => this.toServerConfig(row));
  }

  async bindServerToChat(alias: string, chatId: number): Promise<void> {
    await this.db.update(servers).set({ boundTelegramChatId: chatId }).where(eq(servers.alias, alias));
  }

  async getServerForChat(chatId: number): Promise<ServerConfig | undefined> {
    const [row] = await this.db.select().from(servers).where(eq(servers.boundTelegramChatId, chatId));
    return row ? this.toServerConfig(row) : undefined;
  }

  async removeServer(alias: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.delete(adminServers).where(eq(adminServers.serverAlias, alias));
      const deleted = await tx.delete(servers).where(eq(servers.alias, alias)).returning({ alias: servers.alias });
      return deleted.length > 0;
    });
  }

  async setDefaultServer(alias: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select({ alias: servers.alias }).from(servers).where(eq(servers.alias, alias));
      if (!row) {
        return false;
      }
      // Clear first: servers_one_default_idx allows only one true row at any moment.
      await tx.update(servers).set({ isDefault: false }).where(eq(servers.isDefault, true));
      await tx.update(servers).set({ isDefault: true }).where(eq(servers.alias, alias));
      return true;
    });
  }

  async getDefaultServer(): Promise<ServerConfig | undefined> {
    const [row] = await this.db.select().from(servers).where(eq(servers.isDefault, true));
    return row ? this.toServerConfig(row) : undefined;
  }

  async getSetting(key: string): Promise<unknown> {
    const [row] = await this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
    return row?.value;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
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

  async listAuditLogForTarget(serverAlias: string, targetName: string, limit: number): Promise<AuditLogEntry[]> {
    return this.selectAuditLog()
      .where(and(eq(auditLog.serverAlias, serverAlias), ilike(auditLog.target, targetName)))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
  }

  async close(): Promise<void> {
    await this.pool.end();
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
      .leftJoin(telegramUsers, eq(telegramUsers.telegramId, auditLog.actorTelegramId))
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

export function createAdminStore(connectionString: string, secretsEncryptionKey: string): AdminStore {
  return new DrizzleAdminStore(connectionString, secretsEncryptionKey);
}
