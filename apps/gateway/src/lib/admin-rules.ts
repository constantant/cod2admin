import {
  hasPermission,
  type Admin,
  type Permission,
} from '@cod2admin/admin-store';

/**
 * Who may change or remove whom, in chat and in the Mini App. Nobody changes the owner or
 * themselves, so a mistyped command can't lock anyone out. Anyone else with `admins.manage`
 * (or the owner) may change the rest — there is no rank above them to protect.
 */
export function mayManageAdmin(
  actor: {
    telegramId: number;
    isOwner: boolean;
    permissions: readonly Permission[];
  },
  target: Pick<Admin, 'telegramId' | 'isOwner'>,
): boolean {
  if (target.isOwner || target.telegramId === actor.telegramId) {
    return false;
  }
  return actor.isOwner || hasPermission(actor, 'admins.manage');
}

/** Why `mayManageAdmin` said no. */
export function cannotManageReason(
  actor: { telegramId: number },
  target: Pick<Admin, 'telegramId' | 'isOwner'>,
): string {
  if (target.telegramId === actor.telegramId) {
    return "You can't change your own permissions.";
  }
  return "You can't change the owner.";
}
