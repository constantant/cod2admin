import type { AdminStore, Permission } from '@cod2admin/admin-store';
import { validateInitData, type InitDataUser } from './init-data.js';

export { hasPermission } from '@cod2admin/admin-store';

export interface MiniAppActor {
  telegramId: number;
  isOwner: boolean;
  /** Stored grants. Empty for the owner — `isOwner` is what grants every permission. */
  permissions: readonly Permission[];
  username: string | null;
  firstName: string | null;
}

export type AuthOutcome =
  | { ok: true; actor: MiniAppActor }
  | { ok: false; status: 401 | 403; error: string; message: string };

export interface AuthOptions {
  botToken: string;
  adminStore: AdminStore;
  /** `MINIAPP_DEV_TELEGRAM_ID`: unsigned requests act as this user (local dev loop only). */
  devTelegramId?: number;
}

/** `@nick`, else the first name, else the ID — how chat shows an admin's messages. */
export function actorLabel(actor: MiniAppActor): string {
  return actor.username
    ? `@${actor.username}`
    : (actor.firstName ?? String(actor.telegramId));
}

/** The `<initData>` from Telegram's recommended `Authorization: tma <initData>` header. */
export function initDataFromHeader(
  authorization: string | undefined,
): string | undefined {
  const match = /^tma\s+(.+)$/i.exec(authorization?.trim() ?? '');
  return match?.[1];
}

/**
 * The Mini App's only gate (docs/PLAN-miniapp.md §8): Telegram's signature on `initData` says who
 * the user is, and `admin-store` says what they may do — the same permissions as the chat bot. A
 * valid Telegram user who isn't staff gets nothing, not a read-only session through another path.
 */
export async function authenticate(
  initData: string | undefined,
  options: AuthOptions,
): Promise<AuthOutcome> {
  let user: InitDataUser;
  if (
    options.devTelegramId !== undefined &&
    (!initData || initData === 'dev')
  ) {
    user = { id: options.devTelegramId, username: null, firstName: 'Dev user' };
  } else {
    const result = validateInitData(initData, options.botToken);
    if (!result.ok) {
      const message =
        result.reason === 'expired'
          ? 'This session is too old — close the app and open it again from the bot.'
          : 'Open this app from the bot in Telegram.';
      return {
        ok: false,
        status: 401,
        error: `auth_${result.reason}`,
        message,
      };
    }
    user = result.user;
  }

  const admin = await options.adminStore.getAdmin(user.id);
  if (!admin) {
    return {
      ok: false,
      status: 403,
      error: 'not_admin',
      message: `You're not an admin of this bot. Ask the owner to add you (your Telegram ID is ${user.id}).`,
    };
  }
  // Remember their current @username/first name, as the chat bot's requireStaff does.
  if (
    options.devTelegramId !== user.id &&
    (admin.username !== user.username || admin.firstName !== user.firstName)
  ) {
    await options.adminStore.saveTelegramUser({
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName,
    });
  }
  return {
    ok: true,
    actor: {
      telegramId: user.id,
      isOwner: admin.isOwner,
      permissions: admin.permissions,
      username: user.username ?? admin.username,
      firstName: user.firstName ?? admin.firstName,
    },
  };
}
