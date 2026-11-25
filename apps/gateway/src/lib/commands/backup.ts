import { BackupCryptoError } from '@cod2admin/backup';
import { ScheduleError, DEFAULT_SCHEDULE } from '../../backup/schedule.js';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

export const BACKUP_USAGE = [
  '/backup — show the backup schedule and the last run',
  '/backup now — make a backup now and send it to the owner',
  '/backup on daily 04:00 — every day at that time (bot’s local time)',
  '/backup on every 12 — every 12 hours',
  '/backup off — stop the schedule',
  '/backup telegram file|notify|off — send the file, a message only, or nothing',
  'The passphrase is never typed here: set it in the Mini App (More → Backup) or BACKUP_PASSPHRASE.',
].join('\n');

/**
 * `/backup [now|on|off|telegram]` — the schedule of docs/PLAN-backup.md §6.1. Exporting and
 * restoring need a passphrase and a file, which stay in the Mini App and the `cod2admin-backup`
 * command; a chat is the wrong place for either.
 */
export async function backupCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const manager = deps.backup;
  if (!manager) {
    await ctx.reply('Backups are not set up on this bot.');
    return;
  }
  const [sub = '', ...args] = matchText(ctx).split(/\s+/).filter(Boolean);
  const audit = (action: string, detailJson?: unknown) =>
    deps.adminStore.recordAuditLog({
      actorTelegramId: ctx.admin!.telegramId,
      action,
      target: null,
      source: 'telegram_command',
      detailJson,
    });

  try {
    switch (sub.toLowerCase()) {
      case '': {
        const schedule = await manager.getSchedule();
        const last = await manager.getLastRun();
        const when = !schedule.enabled
          ? 'off'
          : schedule.mode === 'daily'
            ? `every day at ${schedule.at}`
            : `every ${schedule.hours} hours`;
        await ctx.reply(
          [
            `Scheduled backup: ${when}`,
            `Telegram: ${schedule.telegram}; groups: ${schedule.groups.join(', ')}; keeps ${schedule.keepLocal} on the host`,
            `Passphrase: ${(await manager.getPassphrase()) ? 'set' : 'NOT set (a schedule cannot run)'}`,
            last
              ? `Last run ${last.at}: ${last.ok ? 'ok' : 'FAILED'}. ${last.message}`
              : 'No scheduled run yet.',
            '',
            BACKUP_USAGE,
          ].join('\n'),
        );
        return;
      }
      case 'now': {
        await ctx.reply('Making a backup…');
        const run = await manager.runNow();
        await audit('backuprun', { ok: run.ok });
        await ctx.reply(run.message);
        return;
      }
      case 'off': {
        const schedule = await manager.getSchedule();
        await manager.setSchedule({ ...schedule, enabled: false });
        await audit('backupschedule', { enabled: false });
        await ctx.reply('The backup schedule is off.');
        return;
      }
      case 'on': {
        const schedule = await manager.getSchedule();
        const [mode, value] = args;
        let next = { ...DEFAULT_SCHEDULE, ...schedule, enabled: true };
        if (mode === 'daily' && value)
          next = { ...next, mode: 'daily', at: value };
        else if (mode === 'every' && value && /^\d+$/.test(value)) {
          next = { ...next, mode: 'hours', hours: Number(value) };
        } else if (mode) {
          await ctx.reply(
            'Usage: /backup on daily 04:00  or  /backup on every 12',
          );
          return;
        }
        const saved = await manager.setSchedule(next);
        await audit('backupschedule', saved);
        await ctx.reply(
          saved.mode === 'daily'
            ? `Backing up every day at ${saved.at}.`
            : `Backing up every ${saved.hours} hours.`,
        );
        return;
      }
      case 'telegram': {
        const choice = args[0];
        if (choice !== 'file' && choice !== 'notify' && choice !== 'off') {
          await ctx.reply('Usage: /backup telegram file|notify|off');
          return;
        }
        const schedule = await manager.getSchedule();
        const saved = await manager.setSchedule({
          ...schedule,
          telegram: choice,
        });
        await audit('backupschedule', saved);
        await ctx.reply(`Telegram delivery: ${choice}.`);
        return;
      }
      default:
        await ctx.reply(BACKUP_USAGE);
    }
  } catch (error) {
    if (error instanceof ScheduleError || error instanceof BackupCryptoError) {
      await ctx.reply(error.message);
      return;
    }
    throw error;
  }
}
