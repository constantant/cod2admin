import { and, desc, eq, gt, ilike, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { banIps, bans } from './schema.js';
import type { Ban, BanChanges, BanIp, BanSearchFilter, BanStore, RecordBanInput, RecordIpBanInput } from './types.js';

/** `ILIKE` pattern for a case-insensitive substring search, with the user's `%`/`_` taken literally. */
function searchPattern(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  return trimmed ? `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : undefined;
}

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

  async listActiveIpBans(): Promise<BanIp[]> {
    return this.db
      .select()
      .from(banIps)
      .where(and(isNull(banIps.unbannedAt), or(isNull(banIps.expiresAt), gt(banIps.expiresAt, new Date()))));
  }

  async listExpiredIpBans(now: Date): Promise<BanIp[]> {
    return this.db
      .select()
      .from(banIps)
      .where(and(isNull(banIps.unbannedAt), isNotNull(banIps.expiresAt), lte(banIps.expiresAt, now)));
  }

  async expireIpBan(id: number): Promise<void> {
    await this.db.delete(banIps).where(eq(banIps.id, id));
  }

  async unbanIp(ip: string): Promise<number> {
    const lifted = await this.db
      .update(banIps)
      .set({ unbannedAt: new Date() })
      .where(and(eq(banIps.ip, ip), isNull(banIps.unbannedAt)))
      .returning({ id: banIps.id });
    return lifted.length;
  }

  async listExpiredBans(now: Date): Promise<Ban[]> {
    return this.db
      .select()
      .from(bans)
      .where(and(isNull(bans.unbannedAt), isNotNull(bans.expiresAt), lte(bans.expiresAt, now)));
  }

  async expireBan(id: number): Promise<void> {
    await this.db.delete(bans).where(eq(bans.id, id));
  }

  async listActiveBans(): Promise<Ban[]> {
    return this.db
      .select()
      .from(bans)
      .where(and(isNull(bans.unbannedAt), or(isNull(bans.expiresAt), gt(bans.expiresAt, new Date()))));
  }

  async unbanByGuid(guid: string): Promise<Ban[]> {
    return this.db
      .update(bans)
      .set({ unbannedAt: new Date() })
      .where(and(eq(bans.guid, guid), isNull(bans.unbannedAt)))
      .returning();
  }

  async listBansByGuid(guid: string, limit: number): Promise<Ban[]> {
    return this.db.select().from(bans).where(eq(bans.guid, guid)).orderBy(desc(bans.bannedAt)).limit(limit);
  }

  async listBansByName(name: string, limit: number): Promise<Ban[]> {
    return this.db.select().from(bans).where(ilike(bans.name, name)).orderBy(desc(bans.bannedAt)).limit(limit);
  }

  async listIpBansByIp(ip: string, limit: number): Promise<BanIp[]> {
    return this.db.select().from(banIps).where(eq(banIps.ip, ip)).orderBy(desc(banIps.bannedAt)).limit(limit);
  }

  async searchBans(filter: BanSearchFilter): Promise<Ban[]> {
    const pattern = searchPattern(filter.query);
    return this.db
      .select()
      .from(bans)
      .where(
        and(
          filter.includeLifted ? undefined : isNull(bans.unbannedAt),
          pattern ? or(ilike(bans.name, pattern), ilike(bans.guid, pattern)) : undefined,
        ),
      )
      .orderBy(desc(bans.bannedAt), desc(bans.id))
      .limit(filter.limit)
      .offset(filter.offset ?? 0);
  }

  async searchIpBans(filter: BanSearchFilter): Promise<BanIp[]> {
    const pattern = searchPattern(filter.query);
    return this.db
      .select()
      .from(banIps)
      .where(
        and(
          filter.includeLifted ? undefined : isNull(banIps.unbannedAt),
          pattern ? or(ilike(banIps.ip, pattern), ilike(banIps.reason, pattern)) : undefined,
        ),
      )
      .orderBy(desc(banIps.bannedAt), desc(banIps.id))
      .limit(filter.limit)
      .offset(filter.offset ?? 0);
  }

  async getBan(id: number): Promise<Ban | undefined> {
    const [row] = await this.db.select().from(bans).where(eq(bans.id, id));
    return row;
  }

  async getIpBan(id: number): Promise<BanIp | undefined> {
    const [row] = await this.db.select().from(banIps).where(eq(banIps.id, id));
    return row;
  }

  async updateBan(id: number, changes: BanChanges): Promise<Ban | undefined> {
    if (changes.reason === undefined && changes.expiresAt === undefined) {
      return this.getBan(id);
    }
    const [row] = await this.db.update(bans).set(changes).where(eq(bans.id, id)).returning();
    return row;
  }

  async updateIpBan(id: number, changes: BanChanges): Promise<BanIp | undefined> {
    if (changes.reason === undefined && changes.expiresAt === undefined) {
      return this.getIpBan(id);
    }
    const [row] = await this.db.update(banIps).set(changes).where(eq(banIps.id, id)).returning();
    return row;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createBanStore(connectionString: string): BanStore {
  return new DrizzleBanStore(connectionString);
}
