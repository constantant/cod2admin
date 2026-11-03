import type { Admin, AdminRole } from '@cod2admin/admin-store';

/**
 * Who may change or remove whom, in chat and in the Mini App. Nobody changes the owner or themselves,
 * so a mistyped command can't lock anyone out, and an admin manages moderators only (docs/PLAN.md §4).
 */
export function mayManageAdmin(
  actor: { telegramId: number; role: AdminRole },
  target: Pick<Admin, 'telegramId' | 'role'>,
): boolean {
  if (target.role === 'owner' || target.telegramId === actor.telegramId) {
    return false;
  }
  return actor.role === 'owner' || target.role === 'moderator';
}

/** Why `mayManageAdmin` said no. */
export function cannotManageReason(
  actor: { telegramId: number },
  target: Pick<Admin, 'telegramId' | 'role'>,
): string {
  if (target.telegramId === actor.telegramId) {
    return "You can't change your own role.";
  }
  return `You can't change ${target.role === 'owner' ? 'the owner' : 'another admin'}.`;
}
