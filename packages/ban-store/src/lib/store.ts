import { and, desc, eq, gt, ilike, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { banIps, bans } from './schema.js';
import type { Ban, BanIp, BanStore, RecordBanInput, RecordIpBanInput } from './types.js';

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
      guid: input.guid ?? null,
      name: input.name,
      reason: input.reason ?? null,
      bannedBy: input.bannedBy,
      expiresAt: input.expiresAt ?? null,
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
      .where(
        and(
          eq(banIps.serverAlias, serverAlias),
          isNull(banIps.unbannedAt),
          or(isNull(banIps.expiresAt), gt(banIps.expiresAt, new Date())),
        ),
      );
  }

  async listExpiredIpBans(serverAlias: string, now: Date): Promise<BanIp[]> {
    return this.db
      .select()
      .from(banIps)
      .where(
        and(eq(banIps.serverAlias, serverAlias), isNull(banIps.unbannedAt), isNotNull(banIps.expiresAt), lte(banIps.expiresAt, now)),
      );
  }

  async expireIpBan(id: number): Promise<void> {
    await this.db.delete(banIps).where(eq(banIps.id, id));
  }

  async unbanIp(serverAlias: string, ip: string): Promise<void> {
    await this.db
      .update(banIps)
      .set({ unbannedAt: new Date() })
      .where(and(eq(banIps.serverAlias, serverAlias), eq(banIps.ip, ip), isNull(banIps.unbannedAt)));
  }

  async listExpiredBans(serverAlias: string, now: Date): Promise<Ban[]> {
    return this.db
      .select()
      .from(bans)
      .where(and(eq(bans.serverAlias, serverAlias), isNull(bans.unbannedAt), isNotNull(bans.expiresAt), lte(bans.expiresAt, now)));
  }

  async expireBan(id: number): Promise<void> {
    await this.db.delete(bans).where(eq(bans.id, id));
  }

  async listActiveBans(serverAlias: string): Promise<Ban[]> {
    return this.db
      .select()
      .from(bans)
      .where(
        and(eq(bans.serverAlias, serverAlias), isNull(bans.unbannedAt), or(isNull(bans.expiresAt), gt(bans.expiresAt, new Date()))),
      );
  }

  async unbanByGuid(serverAlias: string, guid: string): Promise<void> {
    await this.db
      .update(bans)
      .set({ unbannedAt: new Date() })
      .where(and(eq(bans.serverAlias, serverAlias), eq(bans.guid, guid), isNull(bans.unbannedAt)));
  }

  async listBansByGuid(serverAlias: string, guid: string, limit: number): Promise<Ban[]> {
    return this.db
      .select()
      .from(bans)
      .where(and(eq(bans.serverAlias, serverAlias), eq(bans.guid, guid)))
      .orderBy(desc(bans.bannedAt))
      .limit(limit);
  }

  async listBansByName(serverAlias: string, name: string, limit: number): Promise<Ban[]> {
    return this.db
      .select()
      .from(bans)
      .where(and(eq(bans.serverAlias, serverAlias), ilike(bans.name, name)))
      .orderBy(desc(bans.bannedAt))
      .limit(limit);
  }

  async listIpBansByIp(serverAlias: string, ip: string, limit: number): Promise<BanIp[]> {
    return this.db
      .select()
      .from(banIps)
      .where(and(eq(banIps.serverAlias, serverAlias), eq(banIps.ip, ip)))
      .orderBy(desc(banIps.bannedAt))
      .limit(limit);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createBanStore(connectionString: string): BanStore {
  return new DrizzleBanStore(connectionString);
}
