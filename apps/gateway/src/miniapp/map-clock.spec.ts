import { describe, expect, it } from 'vitest';
import { MapStartTracker, timeLimitMinutes } from './map-clock.js';

describe('timeLimitMinutes', () => {
  it('reads the mode’s own limit', () => {
    expect(timeLimitMinutes({ scr_ctf_timelimit: '20' }, 'ctf')).toBe(20);
    expect(timeLimitMinutes({ scr_ctfb_timelimit: '15' }, 'ctfb')).toBe(15);
    expect(timeLimitMinutes({ SCR_TDM_TIMELIMIT: '10' }, 'tdm')).toBe(10);
  });

  it('is undefined when unlimited, missing, or the mode has no per-map clock', () => {
    expect(timeLimitMinutes({ scr_ctf_timelimit: '0' }, 'ctf')).toBeUndefined();
    expect(timeLimitMinutes({}, 'ctf')).toBeUndefined();
    expect(timeLimitMinutes({ scr_sd_timelimit: '5' }, 'sd')).toBeUndefined();
    expect(timeLimitMinutes({ scr_ctf_timelimit: '20' }, null)).toBeUndefined();
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
