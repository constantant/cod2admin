import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpGrantRow, McpRepository } from '@cod2admin/admin-store';
import type { Permission } from '@cod2admin/admin-store';
import { redirectHost } from './redirect.js';
import { scopeFromPermissions } from './scope.js';

const PENDING_TTL_MS = 5 * 60_000;
const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 10 * 60_000;
const REFRESH_TTL_MS = 14 * 24 * 60 * 60_000;

export interface OAuthFailure {
  error:
    'invalid_request' | 'invalid_grant' | 'invalid_client' | 'invalid_scope';
  description: string;
  status: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface McpCaller {
  telegramId: number;
  /** Snapshot intersected later with the person's live permissions. */
  permissions: string[];
  grantId: string;
  clientName: string;
}

export interface PendingApproval {
  publicId: string;
  clientName: string;
  redirectHost: string;
  scope: string;
  expiresAt: Date;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** S256 challenge, unpadded base64url, as PKCE requires. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function pkceVerifierOk(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Authorization-code grants for AI apps. Access tokens last minutes, refresh tokens rotate, and
 * presenting a refresh token that already rotated revokes the whole connection.
 */
export class McpSessions {
  constructor(
    private readonly repository: McpRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async begin(input: {
    clientId: string;
    clientName: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scope: string;
    state: string;
  }): Promise<{
    approveToken: string;
    browserToken: string;
    publicId: string;
  }> {
    const approveToken = token();
    const browserToken = token();
    const publicId = randomBytes(16).toString('hex');
    const now = this.now();
    await this.repository.insertPending({
      publicId,
      approveHash: hash(approveToken),
      browserHash: hash(browserToken),
      clientId: input.clientId,
      clientName: input.clientName,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      resource: input.resource,
      scope: input.scope,
      state: input.state,
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
      telegramId: null,
      permissions: null,
      decision: null,
      codeIssued: false,
    });
    return { approveToken, browserToken, publicId };
  }

  /** The person opened the Telegram link. Does not approve anything. */
  async open(
    approveToken: string,
    telegramId: number,
  ): Promise<PendingApproval | 'unknown' | 'expired' | 'taken' | 'decided'> {
    const row = await this.repository.findPendingByApproveHash(
      hash(approveToken),
    );
    if (!row) {
      return 'unknown';
    }
    if (row.expiresAt <= this.now()) {
      return 'expired';
    }
    if (row.decision) {
      return 'decided';
    }
    if (row.telegramId !== null && row.telegramId !== telegramId) {
      return 'taken';
    }
    if (row.telegramId === null) {
      const claimed = await this.repository.claimPending(
        row.publicId,
        telegramId,
        this.now(),
      );
      if (!claimed) {
        return 'taken';
      }
    }
    return {
      publicId: row.publicId,
      clientName: row.clientName,
      redirectHost: redirectHost(row.redirectUri),
      scope: row.scope,
      expiresAt: row.expiresAt,
    };
  }

  /** The approval the button refers to, if it is still open. */
  async describe(
    publicId: string,
  ): Promise<{ telegramId: number | null; scope: string } | undefined> {
    const row = await this.repository.findPendingByPublicId(publicId);
    if (!row || row.expiresAt <= this.now()) {
      return undefined;
    }
    return { telegramId: row.telegramId, scope: row.scope };
  }

  async decide(
    publicId: string,
    telegramId: number,
    decision: 'allow' | 'read' | 'deny',
    permissions: readonly Permission[],
  ): Promise<boolean> {
    return this.repository.decidePending(
      publicId,
      telegramId,
      decision,
      decision === 'allow' ? [...permissions] : [],
      this.now(),
    );
  }

  /**
   * What the browser page should do. An approval produces exactly one code; a second poll does
   * not produce another.
   */
  async poll(
    browserToken: string,
    issuer: string,
  ): Promise<
    | { status: 'pending' }
    | { status: 'approved'; redirect: string }
    | { status: 'denied'; redirect: string }
    | { status: 'expired' }
    | { status: 'used' }
  > {
    const row = await this.repository.findPendingByBrowserHash(
      hash(browserToken),
    );
    if (!row || row.expiresAt <= this.now()) {
      return { status: 'expired' };
    }
    if (!row.decision) {
      return { status: 'pending' };
    }
    if (row.decision === 'deny') {
      return {
        status: 'denied',
        redirect: this.errorRedirect(row.redirectUri, row.state, issuer),
      };
    }
    if (row.codeIssued) {
      return { status: 'used' };
    }
    const code = token();
    const issued = await this.repository.markCodeIssued(
      row.browserHash,
      this.now(),
    );
    if (!issued) {
      return { status: 'used' };
    }
    const permissions = row.decision === 'read' ? [] : (row.permissions ?? []);
    await this.repository.insertCode({
      codeHash: hash(code),
      telegramId: row.telegramId!,
      permissions,
      clientId: row.clientId,
      clientName: row.clientName,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      resource: row.resource,
      scope: scopeFromPermissions(permissions as Permission[]),
      expiresAt: new Date(this.now().getTime() + CODE_TTL_MS),
      usedGrantId: null,
    });
    return {
      status: 'approved',
      redirect: this.codeRedirect(row.redirectUri, code, row.state, issuer),
    };
  }

  async exchangeCode(input: {
    code: string;
    verifier: string;
    clientId: string;
    redirectUri: string;
    resource: string;
  }): Promise<IssuedTokens | OAuthFailure> {
    const row = await this.repository.findCode(hash(input.code));
    if (!row) {
      return failure('invalid_grant', 'Unknown authorization code.');
    }
    if (row.usedGrantId) {
      await this.repository.revokeGrant(row.usedGrantId, this.now());
      return failure('invalid_grant', 'Authorization code was already used.');
    }
    if (row.expiresAt <= this.now()) {
      return failure('invalid_grant', 'Authorization code has expired.');
    }
    if (
      row.clientId !== input.clientId ||
      row.redirectUri !== input.redirectUri ||
      row.resource !== input.resource
    ) {
      return failure(
        'invalid_grant',
        'Authorization code does not match this client.',
      );
    }
    if (
      !pkceVerifierOk(input.verifier) ||
      !same(pkceChallenge(input.verifier), row.codeChallenge)
    ) {
      return failure('invalid_grant', 'PKCE verification failed.');
    }

    // Insert before marking the code used. Two exchanges can pass the checks above
    // together; the one that loses must revoke a grant row that already exists.
    const issued = this.issue(row.telegramId, row);
    await this.repository.insertGrant(issued.grant);
    await this.repository.insertAccess(issued.access);
    let won = false;
    try {
      won = await this.repository.markCodeUsed(row.codeHash, issued.grant.id);
    } catch (error) {
      await this.repository.revokeGrant(issued.grant.id, this.now());
      throw error;
    }
    if (!won) {
      await this.repository.revokeGrant(issued.grant.id, this.now());
      const again = await this.repository.findCode(row.codeHash);
      if (again?.usedGrantId) {
        await this.repository.revokeGrant(again.usedGrantId, this.now());
      }
      return failure('invalid_grant', 'Authorization code was already used.');
    }
    return issued.tokens;
  }

  async refresh(input: {
    refreshToken: string;
    clientId: string;
    resource: string;
  }): Promise<IssuedTokens | OAuthFailure> {
    const hashed = hash(input.refreshToken);
    const current = await this.repository.findGrantByRefreshHash(hashed);
    if (!current) {
      const retired = await this.repository.findRetiredGrantId(hashed);
      if (retired) {
        await this.repository.revokeGrant(retired, this.now());
      }
      return failure('invalid_grant', 'Refresh token is not valid.');
    }
    if (current.revokedAt || current.refreshExpiresAt <= this.now()) {
      return failure('invalid_grant', 'This connection has ended.');
    }
    if (
      current.clientId !== input.clientId ||
      current.resource !== input.resource
    ) {
      return failure(
        'invalid_grant',
        'Refresh token does not match this client.',
      );
    }

    const nextRefresh = token();
    const rotated = await this.repository.rotateRefresh(
      current.id,
      hashed,
      hash(nextRefresh),
      this.now(),
    );
    if (!rotated) {
      await this.repository.revokeGrant(current.id, this.now());
      return failure('invalid_grant', 'Refresh token was already used.');
    }
    const accessToken = token();
    await this.repository.insertAccess({
      tokenHash: hash(accessToken),
      grantId: current.id,
      expiresAt: new Date(this.now().getTime() + ACCESS_TTL_MS),
    });
    return {
      accessToken,
      refreshToken: nextRefresh,
      expiresIn: ACCESS_TTL_MS / 1000,
      scope: current.scope,
    };
  }

  /** Revokes the connection behind either an access token or a refresh token. */
  async revokeToken(raw: string): Promise<void> {
    const hashed = hash(raw);
    const access = await this.repository.findAccess(hashed);
    if (access) {
      await this.repository.revokeGrant(access.grantId, this.now());
      return;
    }
    const grant = await this.repository.findGrantByRefreshHash(hashed);
    if (grant) {
      await this.repository.revokeGrant(grant.id, this.now());
      return;
    }
    const retired = await this.repository.findRetiredGrantId(hashed);
    if (retired) {
      await this.repository.revokeGrant(retired, this.now());
    }
  }

  async authenticate(accessToken: string): Promise<McpCaller | undefined> {
    const access = await this.repository.findAccess(hash(accessToken));
    if (!access || access.expiresAt <= this.now()) {
      return undefined;
    }
    const grant = await this.repository.findGrant(access.grantId);
    if (!grant || grant.revokedAt || grant.refreshExpiresAt <= this.now()) {
      return undefined;
    }
    return {
      telegramId: grant.telegramId,
      permissions: grant.permissions,
      grantId: grant.id,
      clientName: grant.clientName,
    };
  }

  list(telegramId: number): Promise<McpGrantRow[]> {
    return this.repository.listLiveGrants(telegramId, this.now());
  }

  async revokeGrant(telegramId: number, grantId: string): Promise<boolean> {
    const grant = await this.repository.findGrant(grantId);
    if (!grant || grant.telegramId !== telegramId || grant.revokedAt) {
      return false;
    }
    await this.repository.revokeGrant(grantId, this.now());
    return true;
  }

  private issue(
    telegramId: number,
    source: {
      clientId: string;
      clientName: string;
      redirectUri: string;
      permissions: string[];
      scope: string;
      resource: string;
    },
  ): {
    grant: McpGrantRow;
    access: { tokenHash: string; grantId: string; expiresAt: Date };
    tokens: IssuedTokens;
  } {
    const now = this.now();
    const grantId = randomBytes(16).toString('hex');
    const accessToken = token();
    const refreshToken = token();
    return {
      grant: {
        id: grantId,
        telegramId,
        clientId: source.clientId,
        clientName: source.clientName,
        redirectHost: redirectHost(source.redirectUri),
        permissions: source.permissions,
        scope: source.scope,
        resource: source.resource,
        refreshHash: hash(refreshToken),
        refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null,
      },
      access: {
        tokenHash: hash(accessToken),
        grantId,
        expiresAt: new Date(now.getTime() + ACCESS_TTL_MS),
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TTL_MS / 1000,
        scope: source.scope,
      },
    };
  }

  private codeRedirect(
    redirectUri: string,
    code: string,
    state: string,
    issuer: string,
  ): string {
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    target.searchParams.set('iss', issuer);
    return target.toString();
  }

  private errorRedirect(
    redirectUri: string,
    state: string,
    issuer: string,
  ): string {
    const target = new URL(redirectUri);
    target.searchParams.set('error', 'access_denied');
    target.searchParams.set('state', state);
    target.searchParams.set('iss', issuer);
    return target.toString();
  }
}

function failure(
  error: OAuthFailure['error'],
  description: string,
): OAuthFailure {
  return { error, description, status: 400 };
}
