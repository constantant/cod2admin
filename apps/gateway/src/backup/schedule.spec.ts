import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE,
  ScheduleError,
  isDue,
  parseSchedule,
  validateSchedule,
} from './schedule.js';

const at = (iso: string) => new Date(iso);
const daily = {
  ...DEFAULT_SCHEDULE,
  enabled: true,
  mode: 'daily' as const,
  at: '04:00',
};
const hours = (n: number) => ({
  ...DEFAULT_SCHEDULE,
  enabled: true,
  mode: 'hours' as const,
  hours: n,
});

describe('isDue (daily)', () => {
  const since = at('2026-11-20T10:00:00');
  it('is not due before the day’s slot, nor for a slot already past when it was turned on', () => {
    expect(isDue(daily, at('2026-11-20T11:00:00'), since, undefined)).toBe(
      false,
    );
    expect(isDue(daily, at('2026-11-21T03:59:00'), since, undefined)).toBe(
      false,
    );
  });
  it('is due at the slot, once', () => {
    expect(isDue(daily, at('2026-11-21T04:00:30'), since, undefined)).toBe(
      true,
    );
    expect(
      isDue(daily, at('2026-11-21T04:01:00'), since, at('2026-11-21T04:00:30')),
    ).toBe(false);
  });
  it('catches up a slot missed while the bot was down, once', () => {
    const last = at('2026-11-21T04:00:30');
    expect(isDue(daily, at('2026-11-23T09:00:00'), since, last)).toBe(true);
    expect(
      isDue(daily, at('2026-11-23T09:01:00'), since, at('2026-11-23T09:00:10')),
    ).toBe(false);
  });
  it('does nothing while off', () => {
    expect(
      isDue(
        { ...daily, enabled: false },
        at('2026-11-23T09:00:00'),
        since,
        undefined,
      ),
    ).toBe(false);
  });
});

describe('isDue (hours)', () => {
  const since = at('2026-11-20T10:00:00');
  it('counts from the last attempt, or from turning it on', () => {
    expect(isDue(hours(6), at('2026-11-20T15:59:00'), since, undefined)).toBe(
      false,
    );
    expect(isDue(hours(6), at('2026-11-20T16:00:00'), since, undefined)).toBe(
      true,
    );
    expect(
      isDue(
        hours(6),
        at('2026-11-20T17:00:00'),
        since,
        at('2026-11-20T16:00:05'),
      ),
    ).toBe(false);
    expect(
      isDue(
        hours(6),
        at('2026-11-20T22:00:06'),
        since,
        at('2026-11-20T16:00:05'),
      ),
    ).toBe(true);
  });
});

describe('schedule values', () => {
  it('reads junk as the defaults', () => {
    expect(
      parseSchedule({ at: '25:99', hours: -1, groups: 'x', keepLocal: 0 }),
    ).toEqual(DEFAULT_SCHEDULE);
    expect(parseSchedule(undefined)).toEqual(DEFAULT_SCHEDULE);
  });
  it('validates what the owner sends', () => {
    expect(validateSchedule({ ...daily, at: '23:30' }).at).toBe('23:30');
    expect(() => validateSchedule({ ...daily, at: '4am' })).toThrow(
      ScheduleError,
    );
    expect(() => validateSchedule({ ...hours(0) })).toThrow(ScheduleError);
    expect(() => validateSchedule({ ...daily, groups: ['bans'] })).toThrow(
      ScheduleError,
    );
    expect(() => validateSchedule({ ...daily, keepLocal: 0 })).toThrow(
      ScheduleError,
    );
    expect(() => validateSchedule({ ...daily, mode: 'weekly' })).toThrow(
      ScheduleError,
    );
  });
});
