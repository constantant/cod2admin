import { describe, expect, it } from 'vitest';
import { ReportAntiSpam } from './anti-spam.js';

describe('ReportAntiSpam', () => {
  it('allows a first report from a reporter as fresh', () => {
    const antiSpam = new ReportAntiSpam<string>({ now: () => 0 });
    expect(antiSpam.check(1, 'Cheatr123')).toEqual({ allowed: true, reason: 'fresh' });
  });

  it('cools down a second, different-target report from the same reporter within the window', () => {
    let clock = 0;
    const antiSpam = new ReportAntiSpam<string>({ cooldownMs: 60_000, now: () => clock });

    antiSpam.track(1, 'Cheatr123', 'card-1');
    clock = 10_000;

    expect(antiSpam.check(1, 'SomeoneElse')).toEqual({ allowed: false, reason: 'cooldown', retryAfterMs: 50_000 });
  });

  it('allows a fresh report again once the cooldown window has passed', () => {
    let clock = 0;
    const antiSpam = new ReportAntiSpam<string>({ cooldownMs: 60_000, now: () => clock });

    antiSpam.track(1, 'Cheatr123', 'card-1');
    clock = 60_001;

    expect(antiSpam.check(1, 'SomeoneElse')).toEqual({ allowed: true, reason: 'fresh' });
  });

  it('collapses a repeat report against the same reporter+target into the existing card, bypassing cooldown', () => {
    let clock = 0;
    const antiSpam = new ReportAntiSpam<string>({ cooldownMs: 60_000, now: () => clock });

    antiSpam.track(1, 'Cheatr123', 'card-1');
    clock = 5_000; // well inside the cooldown window

    expect(antiSpam.check(1, 'Cheatr123')).toEqual({ allowed: true, reason: 'duplicate', existing: 'card-1' });
  });

  it('matches the dedup target case-insensitively and trims whitespace', () => {
    const antiSpam = new ReportAntiSpam<string>({ now: () => 0 });
    antiSpam.track(1, 'Cheatr123', 'card-1');

    expect(antiSpam.check(1, '  CHEATR123  ')).toEqual({ allowed: true, reason: 'duplicate', existing: 'card-1' });
  });

  it('does not collapse reports from different reporters against the same target', () => {
    const antiSpam = new ReportAntiSpam<string>({ now: () => 0 });
    antiSpam.track(1, 'Cheatr123', 'card-1');

    expect(antiSpam.check(2, 'Cheatr123')).toEqual({ allowed: true, reason: 'fresh' });
  });

  it('slides the dedup window forward on each tracked duplicate, so an actively-reported card stays open', () => {
    let clock = 0;
    const antiSpam = new ReportAntiSpam<string>({ cooldownMs: 60_000, dedupWindowMs: 30_000, now: () => clock });

    antiSpam.track(1, 'Cheatr123', 'card-1');
    clock = 20_000;
    expect(antiSpam.check(1, 'Cheatr123').reason).toBe('duplicate');
    antiSpam.track(1, 'Cheatr123', 'card-1'); // still open, refresh it

    clock = 45_000; // 25s after the refresh — still within the 30s dedup window from the refresh
    expect(antiSpam.check(1, 'Cheatr123')).toEqual({ allowed: true, reason: 'duplicate', existing: 'card-1' });
  });

  it('stops collapsing once the dedup window lapses with no further reports', () => {
    let clock = 0;
    const antiSpam = new ReportAntiSpam<string>({ cooldownMs: 60_000, dedupWindowMs: 30_000, now: () => clock });

    antiSpam.track(1, 'Cheatr123', 'card-1');
    clock = 30_001;

    // No longer a duplicate (window lapsed) - and cooldown blocks a fresh one too, since it's
    // the same reporter within cooldownMs of their last tracked report.
    expect(antiSpam.check(1, 'Cheatr123')).toEqual({ allowed: false, reason: 'cooldown', retryAfterMs: 29_999 });
  });

  it('resolve() ends dedup collapsing for that reporter+target, so the next report is fresh (once cooldown allows)', () => {
    let clock = 0;
    const antiSpam = new ReportAntiSpam<string>({ cooldownMs: 60_000, now: () => clock });

    antiSpam.track(1, 'Cheatr123', 'card-1');
    antiSpam.resolve(1, 'Cheatr123');
    clock = 60_001; // clear the cooldown too, to isolate what resolve() itself changed

    expect(antiSpam.check(1, 'Cheatr123')).toEqual({ allowed: true, reason: 'fresh' });
  });
});
