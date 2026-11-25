import type {
  BackupGroup,
  BackupSchedule,
} from '../miniapp/api-types.js';

export const SCHEDULE_KEY = 'backup.schedule';
/** When the schedule was turned on, saved beside it. */
export function sinceOf(value: unknown): Date {
  const raw = (value && typeof value === 'object' ? value : {}) as { since?: unknown };
  const date = typeof raw.since === 'string' ? new Date(raw.since) : new Date(NaN);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export const LAST_RUN_KEY = 'backup.lastRun';
export const PASSPHRASE_KEY = 'backup.passphrase';

export const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  mode: 'daily',
  at: '04:00',
  hours: 24,
  groups: ['core', 'bans', 'history', 'functions'],
  telegram: 'file',
  keepLocal: 7,
};

const GROUPS: readonly BackupGroup[] = [
  'core',
  'bans',
  'history',
  'functions',
  'watch',
];

/** Reads the stored value defensively: anything off falls back to the default for that field. */
export function parseSchedule(value: unknown): BackupSchedule {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<
    string,
    unknown
  >;
  const groups = Array.isArray(raw.groups)
    ? (raw.groups.filter((g) => GROUPS.includes(g as BackupGroup)) as BackupGroup[])
    : DEFAULT_SCHEDULE.groups;
  return {
    enabled: raw.enabled === true,
    mode: raw.mode === 'hours' ? 'hours' : 'daily',
    at:
      typeof raw.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.at)
        ? raw.at
        : DEFAULT_SCHEDULE.at,
    hours:
      Number.isInteger(raw.hours) &&
      (raw.hours as number) >= 1 &&
      (raw.hours as number) <= 24 * 30
        ? (raw.hours as number)
        : DEFAULT_SCHEDULE.hours,
    // `core` is the point of a backup: a schedule without it is refused, not silently fixed.
    groups: groups.includes('core') ? groups : DEFAULT_SCHEDULE.groups,
    telegram:
      raw.telegram === 'notify' || raw.telegram === 'off'
        ? raw.telegram
        : 'file',
    keepLocal:
      Number.isInteger(raw.keepLocal) &&
      (raw.keepLocal as number) >= 1 &&
      (raw.keepLocal as number) <= 60
        ? (raw.keepLocal as number)
        : DEFAULT_SCHEDULE.keepLocal,
  };
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/** Strict check for what the owner sends (the stored value is read leniently above). */
export function validateSchedule(input: unknown): BackupSchedule {
  const value = parseSchedule(input);
  const raw = (input ?? {}) as Record<string, unknown>;
  if (raw.mode !== 'daily' && raw.mode !== 'hours') {
    throw new ScheduleError('mode must be "daily" or "hours".');
  }
  if (raw.mode === 'daily' && raw.at !== value.at) {
    throw new ScheduleError('The time must look like 04:00.');
  }
  if (raw.mode === 'hours' && raw.hours !== value.hours) {
    throw new ScheduleError('Hours must be a whole number from 1 to 720.');
  }
  if (!Array.isArray(raw.groups) || !raw.groups.includes('core')) {
    throw new ScheduleError('Choose at least the core group.');
  }
  if (raw.keepLocal !== value.keepLocal) {
    throw new ScheduleError('Keep between 1 and 60 files on the host.');
  }
  return value;
}

/**
 * Whether a run is due. `since` is when the schedule was turned on.
 *
 * `daily`: the latest `HH:MM` slot that is not in the future, if it is after `since`. A run is due
 * when no attempt has been made since that slot, so a slot missed while the bot was down runs once
 * at the next check, and turning the schedule on does not fire for a slot already past.
 * `hours`: this many hours after the last attempt (after `since` before the first one).
 */
export function isDue(
  schedule: BackupSchedule,
  now: Date,
  since: Date,
  lastAttempt: Date | undefined,
): boolean {
  if (!schedule.enabled) return false;
  if (schedule.mode === 'hours') {
    const anchor = lastAttempt ?? since;
    return now.getTime() >= anchor.getTime() + schedule.hours * 3_600_000;
  }
  const [h, m] = schedule.at.split(':').map(Number);
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (slot.getTime() > now.getTime()) {
    slot.setDate(slot.getDate() - 1);
    slot.setHours(h, m, 0, 0);
  }
  if (slot.getTime() <= since.getTime()) return false;
  return !lastAttempt || lastAttempt.getTime() < slot.getTime();
}
