import { desc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { admins, auditLog, servers } from './schema.js';
import { SecretBox } from './secrets.js';
import type {
  Admin,
  AdminRole,
  AdminStore,
  AuditLogEntry,
  ClaimOwnerResult,
  RecordAuditLogInput,
  ServerConfig,
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

function toAdmin(row: typeof admins.$inferSelect): Admin {
  return { telegramId: row.telegramId, role: row.role, addedBy: row.addedBy, addedAt: row.addedAt };
}

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
    const [row] = await this.db.select().from(admins).where(eq(admins.telegramId, telegramId));
    return row ? toAdmin(row) : undefined;
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
    const rows = await this.db.select().from(admins);
    return rows.map(toAdmin);
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
        set: { rconHost: input.rconHost, rconPort: input.rconPort, rconPasswordEncrypted },
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
    const rows = await this.db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);
    return rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private toServerConfig(row: typeof servers.$inferSelect): ServerConfig {
    return {
      alias: row.alias,
      rconHost: row.rconHost,
      rconPort: row.rconPort,
      rconPassword: this.secretBox.decrypt(row.rconPasswordEncrypted),
      logSourceConfig: row.logSourceConfig,
      boundTelegramChatId: row.boundTelegramChatId,
    };
  }
}

export function createAdminStore(connectionString: string, secretsEncryptionKey: string): AdminStore {
  return new DrizzleAdminStore(connectionString, secretsEncryptionKey);
}
