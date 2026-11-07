import { Pool, type QueryResultRow } from 'pg';

/** `allow` stores a permission snapshot. `read` stores an empty list. `deny` stores nothing. */
export type McpDecision = 'allow' | 'read' | 'deny';

export interface McpPendingRow {
  publicId: string;
  approveHash: string;
  browserHash: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string;
  expiresAt: Date;
  telegramId: number | null;
  permissions: string[] | null;
  decision: McpDecision | null;
  codeIssued: boolean;
}

export interface McpCodeRow {
  codeHash: string;
  telegramId: number;
  permissions: string[];
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: Date;
  usedGrantId: string | null;
}

export interface McpGrantRow {
  id: string;
  telegramId: number;
  clientId: string;
  clientName: string;
  redirectHost: string;
  permissions: string[];
  scope: string;
  resource: string;
  refreshHash: string;
  refreshExpiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
}

export interface McpAccessRow {
  tokenHash: string;
  grantId: string;
  expiresAt: Date;
}

/**
 * Persistence for AI connections. Security rules (single use, rotation, reuse) live with the
 * caller; these methods are the atomic updates those rules need.
 */
export interface McpRepository {
  insertPending(row: McpPendingRow): Promise<void>;
  findPendingByApproveHash(hash: string): Promise<McpPendingRow | undefined>;
  findPendingByBrowserHash(hash: string): Promise<McpPendingRow | undefined>;
  findPendingByPublicId(id: string): Promise<McpPendingRow | undefined>;
  /**
   * Binds the request to the first staff member who opens it. `false` when it is expired,
   * missing, or already bound to someone.
   */
  claimPending(publicId: string, telegramId: number, now: Date): Promise<boolean>;
  /**
   * Records the decision once. `false` when it is missing, expired, unbound, bound to someone
   * else, or already decided.
   */
  decidePending(
    publicId: string,
    telegramId: number,
    decision: McpDecision,
    permissions: string[],
    now: Date,
  ): Promise<boolean>;
  /**
   * Marks the request as having produced its one authorization code. `false` when another
   * caller already did, or the request is not an approval that is still valid.
   */
  markCodeIssued(browserHash: string, now: Date): Promise<boolean>;

  insertCode(row: McpCodeRow): Promise<void>;
  findCode(hash: string): Promise<McpCodeRow | undefined>;
  /** Sets `usedGrantId` when it was still null. `false` if the code is missing or already used. */
  markCodeUsed(hash: string, grantId: string): Promise<boolean>;

  insertGrant(row: McpGrantRow): Promise<void>;
  findGrant(id: string): Promise<McpGrantRow | undefined>;
  findGrantByRefreshHash(hash: string): Promise<McpGrantRow | undefined>;
  findRetiredGrantId(refreshHash: string): Promise<string | undefined>;
  /**
   * Swaps the current refresh hash for a new one and remembers the old hash. `false` when the
   * old hash is no longer current, so two refreshes cannot both succeed.
   */
  rotateRefresh(
    grantId: string,
    oldHash: string,
    newHash: string,
    now: Date,
  ): Promise<boolean>;
  revokeGrant(id: string, now: Date): Promise<void>;
  listLiveGrants(telegramId: number, now: Date): Promise<McpGrantRow[]>;

  insertAccess(row: McpAccessRow): Promise<void>;
  findAccess(tokenHash: string): Promise<McpAccessRow | undefined>;

  close(): Promise<void>;
}

function asDecision(value: string | null): McpDecision | null {
  return value === 'allow' || value === 'read' || value === 'deny' ? value : null;
}

interface PendingRecord extends McpPendingRow {}

/** In-memory stand-in. Check-and-set stays synchronous so two awaits cannot both win. */
export function createMemoryMcpRepository(): McpRepository {
  const pending = new Map<string, PendingRecord>();
  const byApprove = new Map<string, PendingRecord>();
  const byBrowser = new Map<string, PendingRecord>();
  const codes = new Map<string, McpCodeRow>();
  const grants = new Map<string, McpGrantRow>();
  const byRefresh = new Map<string, McpGrantRow>();
  const retired = new Map<string, string>();
  const access = new Map<string, McpAccessRow>();

  return {
    async insertPending(row) {
      const stored = { ...row, permissions: row.permissions ? [...row.permissions] : null };
      pending.set(row.publicId, stored);
      byApprove.set(row.approveHash, stored);
      byBrowser.set(row.browserHash, stored);
    },
    async findPendingByApproveHash(hash) {
      return byApprove.get(hash);
    },
    async findPendingByBrowserHash(hash) {
      return byBrowser.get(hash);
    },
    async findPendingByPublicId(id) {
      return pending.get(id);
    },
    async claimPending(publicId, telegramId, now) {
      const row = pending.get(publicId);
      if (!row || row.telegramId !== null || row.expiresAt <= now) {
        return false;
      }
      row.telegramId = telegramId;
      return true;
    },
    async decidePending(publicId, telegramId, decision, permissions, now) {
      const row = pending.get(publicId);
      if (
        !row ||
        row.telegramId !== telegramId ||
        row.decision !== null ||
        row.expiresAt <= now
      ) {
        return false;
      }
      row.decision = decision;
      row.permissions = [...permissions];
      return true;
    },
    async markCodeIssued(browserHash, now) {
      const row = byBrowser.get(browserHash);
      if (
        !row ||
        row.codeIssued ||
        row.expiresAt <= now ||
        (row.decision !== 'allow' && row.decision !== 'read')
      ) {
        return false;
      }
      row.codeIssued = true;
      return true;
    },
    async insertCode(row) {
      codes.set(row.codeHash, { ...row, permissions: [...row.permissions] });
    },
    async findCode(hash) {
      return codes.get(hash);
    },
    async markCodeUsed(hash, grantId) {
      const row = codes.get(hash);
      if (!row || row.usedGrantId !== null) {
        return false;
      }
      row.usedGrantId = grantId;
      return true;
    },
    async insertGrant(row) {
      const stored = { ...row, permissions: [...row.permissions] };
      grants.set(row.id, stored);
      byRefresh.set(row.refreshHash, stored);
    },
    async findGrant(id) {
      return grants.get(id);
    },
    async findGrantByRefreshHash(hash) {
      return byRefresh.get(hash);
    },
    async findRetiredGrantId(refreshHash) {
      return retired.get(refreshHash);
    },
    async rotateRefresh(grantId, oldHash, newHash, now) {
      const row = grants.get(grantId);
      if (!row || row.refreshHash !== oldHash || row.revokedAt) {
        return false;
      }
      byRefresh.delete(oldHash);
      retired.set(oldHash, grantId);
      row.refreshHash = newHash;
      row.lastUsedAt = now;
      byRefresh.set(newHash, row);
      return true;
    },
    async revokeGrant(id, now) {
      const row = grants.get(id);
      if (row && !row.revokedAt) {
        row.revokedAt = now;
      }
    },
    async listLiveGrants(telegramId, now) {
      return [...grants.values()].filter(
        (row) =>
          row.telegramId === telegramId &&
          !row.revokedAt &&
          row.refreshExpiresAt > now,
      );
    },
    async insertAccess(row) {
      access.set(row.tokenHash, { ...row });
    },
    async findAccess(tokenHash) {
      return access.get(tokenHash);
    },
    async close() {},
  };
}

interface PendingDb {
  public_id: string;
  approve_hash: string;
  browser_hash: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  state: string;
  expires_at: Date;
  telegram_id: string | number | null;
  permissions: string[] | null;
  decision: string | null;
  code_issued: boolean;
}

function pendingFrom(row: PendingDb): McpPendingRow {
  return {
    publicId: row.public_id,
    approveHash: row.approve_hash,
    browserHash: row.browser_hash,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scope: row.scope,
    state: row.state,
    expiresAt: row.expires_at,
    telegramId: row.telegram_id === null ? null : Number(row.telegram_id),
    permissions: row.permissions,
    decision: asDecision(row.decision),
    codeIssued: row.code_issued,
  };
}

interface CodeDb {
  code_hash: string;
  telegram_id: string | number;
  permissions: string[];
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  expires_at: Date;
  used_grant_id: string | null;
}

function codeFrom(row: CodeDb): McpCodeRow {
  return {
    codeHash: row.code_hash,
    telegramId: Number(row.telegram_id),
    permissions: row.permissions,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scope: row.scope,
    expiresAt: row.expires_at,
    usedGrantId: row.used_grant_id,
  };
}

interface GrantDb {
  id: string;
  telegram_id: string | number;
  client_id: string;
  client_name: string;
  redirect_host: string;
  permissions: string[];
  scope: string;
  resource: string;
  refresh_hash: string;
  refresh_expires_at: Date;
  created_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
}

function grantFrom(row: GrantDb): McpGrantRow {
  return {
    id: row.id,
    telegramId: Number(row.telegram_id),
    clientId: row.client_id,
    clientName: row.client_name,
    redirectHost: row.redirect_host,
    permissions: row.permissions,
    scope: row.scope,
    resource: row.resource,
    refreshHash: row.refresh_hash,
    refreshExpiresAt: row.refresh_expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

const PENDING_COLUMNS = `public_id, approve_hash, browser_hash, client_id, client_name,
  redirect_uri, code_challenge, resource, scope, state, expires_at, telegram_id,
  permissions, decision, code_issued`;

const CODE_COLUMNS = `code_hash, telegram_id, permissions, client_id, client_name, redirect_uri,
  code_challenge, resource, scope, expires_at, used_grant_id`;

const GRANT_COLUMNS = `id, telegram_id, client_id, client_name, redirect_host, permissions, scope,
  resource, refresh_hash, refresh_expires_at, created_at, last_used_at, revoked_at`;

/** Postgres backing for `McpRepository`, using its own pool on the gateway database. */
export function createMcpRepository(connectionString: string): McpRepository {
  const pool = new Pool({ connectionString });

  async function one<T extends QueryResultRow>(
    sql: string,
    params: unknown[],
  ): Promise<T | undefined> {
    const result = await pool.query<T>(sql, params);
    return result.rows[0];
  }

  return {
    async insertPending(row) {
      await pool.query(
        `INSERT INTO mcp_pending (${PENDING_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          row.publicId,
          row.approveHash,
          row.browserHash,
          row.clientId,
          row.clientName,
          row.redirectUri,
          row.codeChallenge,
          row.resource,
          row.scope,
          row.state,
          row.expiresAt,
          row.telegramId,
          row.permissions,
          row.decision,
          row.codeIssued,
        ],
      );
    },
    async findPendingByApproveHash(hash) {
      const row = await one<PendingDb>(
        `SELECT ${PENDING_COLUMNS} FROM mcp_pending WHERE approve_hash = $1`,
        [hash],
      );
      return row ? pendingFrom(row) : undefined;
    },
    async findPendingByBrowserHash(hash) {
      const row = await one<PendingDb>(
        `SELECT ${PENDING_COLUMNS} FROM mcp_pending WHERE browser_hash = $1`,
        [hash],
      );
      return row ? pendingFrom(row) : undefined;
    },
    async findPendingByPublicId(id) {
      const row = await one<PendingDb>(
        `SELECT ${PENDING_COLUMNS} FROM mcp_pending WHERE public_id = $1`,
        [id],
      );
      return row ? pendingFrom(row) : undefined;
    },
    async claimPending(publicId, telegramId, now) {
      const result = await pool.query(
        `UPDATE mcp_pending SET telegram_id = $2
         WHERE public_id = $1 AND telegram_id IS NULL AND decision IS NULL AND expires_at > $3`,
        [publicId, telegramId, now],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async decidePending(publicId, telegramId, decision, permissions, now) {
      const result = await pool.query(
        `UPDATE mcp_pending SET decision = $3, permissions = $4
         WHERE public_id = $1 AND telegram_id = $2 AND decision IS NULL AND expires_at > $5`,
        [publicId, telegramId, decision, permissions, now],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async markCodeIssued(browserHash, now) {
      const result = await pool.query(
        `UPDATE mcp_pending SET code_issued = true
         WHERE browser_hash = $1 AND code_issued = false AND expires_at > $2
           AND decision IN ('allow', 'read')`,
        [browserHash, now],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async insertCode(row) {
      await pool.query(
        `INSERT INTO mcp_codes (${CODE_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          row.codeHash,
          row.telegramId,
          row.permissions,
          row.clientId,
          row.clientName,
          row.redirectUri,
          row.codeChallenge,
          row.resource,
          row.scope,
          row.expiresAt,
          row.usedGrantId,
        ],
      );
    },
    async findCode(hash) {
      const row = await one<CodeDb>(
        `SELECT ${CODE_COLUMNS} FROM mcp_codes WHERE code_hash = $1`,
        [hash],
      );
      return row ? codeFrom(row) : undefined;
    },
    async markCodeUsed(hash, grantId) {
      const result = await pool.query(
        `UPDATE mcp_codes SET used_grant_id = $2
         WHERE code_hash = $1 AND used_grant_id IS NULL`,
        [hash, grantId],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async insertGrant(row) {
      await pool.query(
        `INSERT INTO mcp_grants (${GRANT_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          row.id,
          row.telegramId,
          row.clientId,
          row.clientName,
          row.redirectHost,
          row.permissions,
          row.scope,
          row.resource,
          row.refreshHash,
          row.refreshExpiresAt,
          row.createdAt,
          row.lastUsedAt,
          row.revokedAt,
        ],
      );
    },
    async findGrant(id) {
      const row = await one<GrantDb>(
        `SELECT ${GRANT_COLUMNS} FROM mcp_grants WHERE id = $1`,
        [id],
      );
      return row ? grantFrom(row) : undefined;
    },
    async findGrantByRefreshHash(hash) {
      const row = await one<GrantDb>(
        `SELECT ${GRANT_COLUMNS} FROM mcp_grants WHERE refresh_hash = $1`,
        [hash],
      );
      return row ? grantFrom(row) : undefined;
    },
    async findRetiredGrantId(refreshHash) {
      const row = await one<{ grant_id: string }>(
        `SELECT grant_id FROM mcp_retired_refresh WHERE refresh_hash = $1`,
        [refreshHash],
      );
      return row?.grant_id;
    },
    async rotateRefresh(grantId, oldHash, newHash, now) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE mcp_grants SET refresh_hash = $3, last_used_at = $4
           WHERE id = $1 AND refresh_hash = $2 AND revoked_at IS NULL`,
          [grantId, oldHash, newHash, now],
        );
        if ((updated.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query(
          `INSERT INTO mcp_retired_refresh (refresh_hash, grant_id) VALUES ($1, $2)`,
          [oldHash, grantId],
        );
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async revokeGrant(id, now) {
      await pool.query(
        `UPDATE mcp_grants SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
        [id, now],
      );
    },
    async listLiveGrants(telegramId, now) {
      const result = await pool.query<GrantDb>(
        `SELECT ${GRANT_COLUMNS} FROM mcp_grants
         WHERE telegram_id = $1 AND revoked_at IS NULL AND refresh_expires_at > $2
         ORDER BY created_at`,
        [telegramId, now],
      );
      return result.rows.map(grantFrom);
    },
    async insertAccess(row) {
      await pool.query(
        `INSERT INTO mcp_access (token_hash, grant_id, expires_at) VALUES ($1, $2, $3)`,
        [row.tokenHash, row.grantId, row.expiresAt],
      );
    },
    async findAccess(tokenHash) {
      const row = await one<{
        token_hash: string;
        grant_id: string;
        expires_at: Date;
      }>(
        `SELECT token_hash, grant_id, expires_at FROM mcp_access WHERE token_hash = $1`,
        [tokenHash],
      );
      return row
        ? {
            tokenHash: row.token_hash,
            grantId: row.grant_id,
            expiresAt: row.expires_at,
          }
        : undefined;
    },
    async close() {
      await pool.end();
    },
  };
}
