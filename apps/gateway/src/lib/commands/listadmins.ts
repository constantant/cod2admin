import type { Admin } from '@cod2admin/admin-store';
import type { BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

function formatAdminLine(admin: Admin): string {
  return `${admin.telegramId} — ${admin.role}`;
}

export function formatAdminsMessage(admins: Admin[]): string {
  if (admins.length === 0) {
    return 'No admins configured.';
  }
  return admins.map(formatAdminLine).join('\n');
}

/** `/listadmins` (docs/PLAN.md §4). */
export async function listAdminsCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const admins = await deps.adminStore.listAdmins();
  await ctx.reply(formatAdminsMessage(admins));
}
