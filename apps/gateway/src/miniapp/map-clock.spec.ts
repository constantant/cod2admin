import { describe, expect, it } from 'vitest';
import { MapStartTracker, parseTimeLimit, timeLimitCvar } from './map-clock.js';

describe('timeLimitCvar', () => {
  it('names the mode’s own cvar, only for timed modes', () => {
    expect(timeLimitCvar('ctf')).toBe('scr_ctf_timelimit');
    expect(timeLimitCvar('CTFB')).toBe('scr_ctfb_timelimit');
    expect(timeLimitCvar('sd')).toBeUndefined();
    expect(timeLimitCvar(null)).toBeUndefined();
  });
});

describe('parseTimeLimit', () => {
  it('is undefined when unlimited or unset', () => {
    expect(parseTimeLimit('20')).toBe(20);
    expect(parseTimeLimit('0')).toBeUndefined();
    expect(parseTimeLimit(null)).toBeUndefined();
  });
});

describe('MapStartTracker', () => {
  it('has no start for the map that was already running when first seen', () => {
    const tracker = new MapStartTracker();
    expect(tracker.observe('a', 'mp_toujane', 1000)).toBeUndefined();
    expect(tracker.observe('a', 'mp_toujane', 2000)).toBeUndefined();
  });

  it('starts the clock when it sees the map change, and keeps it', () => {
    const tracker = new MapStartTracker();
    tracker.observe('a', 'mp_toujane', 1000);
    expect(tracker.observe('a', 'mp_harbor', 2000)).toBe(2000);
    expect(tracker.observe('a', 'mp_harbor', 3000)).toBe(2000);
  });

  it('tracks servers separately', () => {
    const tracker = new MapStartTracker();
    tracker.observe('a', 'mp_toujane', 1000);
    tracker.observe('b', 'mp_toujane', 1000);
    tracker.observe('a', 'mp_harbor', 2000);
    expect(tracker.observe('b', 'mp_toujane', 3000)).toBeUndefined();
  });
});
