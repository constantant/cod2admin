import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { banIps, bans } from './schema.js';
import type { BanIp, BanStore, RecordBanInput, RecordIpBanInput } from './types.js';

export class DrizzleBanStore implements BanStore {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.db = drizzle(this.pool);
  }

  async recordBan(input: RecordBanInput): Promise<void> {
    await this.db.insert(bans).values({
      serverAlias: input.serverAlias,
      guid: null,
      name: input.name,
      reason: input.reason ?? null,
      bannedBy: input.bannedBy,
      expiresAt: null,
    });
  }

  async recordIpBan(input: RecordIpBanInput): Promise<void> {
    await this.db.insert(banIps).values({
      serverAlias: input.serverAlias,
      ip: input.ip,
      reason: input.reason ?? null,
      bannedBy: input.bannedBy,
      expiresAt: input.expiresAt,
    });
  }

  async listActiveIpBans(serverAlias: string): Promise<BanIp[]> {
    return this.db
      .select()
      .from(banIps)
      .where(and(eq(banIps.serverAlias, serverAlias), or(isNull(banIps.expiresAt), gt(banIps.expiresAt, new Date()))));
  }

  async listExpiredIpBans(serverAlias: string, now: Date): Promise<BanIp[]> {
    return this.db
      .select()
      .from(banIps)
      .where(and(eq(banIps.serverAlias, serverAlias), isNotNull(banIps.expiresAt), lte(banIps.expiresAt, now)));
  }

  async expireIpBan(id: number): Promise<void> {
    await this.db.delete(banIps).where(eq(banIps.id, id));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createBanStore(connectionString: string): BanStore {
  return new DrizzleBanStore(connectionString);
}
