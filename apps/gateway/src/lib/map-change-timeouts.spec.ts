import { UdpQueryTimeoutError } from '@cod2admin/rcon-client';
import { describe, expect, it, vi } from 'vitest';
import {
  MAP_CHANGE_GRACE_MS,
  MapChangeTimeouts,
  reportRconError,
} from './map-change-timeouts.js';

const timeout = () =>
  new UdpQueryTimeoutError(
    'Timed out waiting for a response to "rcon" after 1000ms',
  );

function setup() {
  let now = 1_000_000;
  const timeouts = new MapChangeTimeouts(() => now);
  return {
    timeouts,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('MapChangeTimeouts', () => {
  it('drops timeouts when the server comes back on another map', () => {
    const { timeouts, advance } = setup();
    const emit = vi.fn();
    timeouts.noteStatus('default', { mapName: 'mp_toujane' });

    timeouts.report('default', timeout(), emit);
    advance(15_000);
    timeouts.report('default', timeout(), emit);
    advance(15_000);
    timeouts.noteStatus('default', { mapName: 'mp_dawnville' });

    expect(emit).not.toHaveBeenCalled();
  });

  it('logs held timeouts when the server comes back on the same map', () => {
    const { timeouts, advance } = setup();
    const first = vi.fn();
    const second = vi.fn();
    timeouts.noteStatus('default', { mapName: 'mp_toujane' });

    timeouts.report('default', timeout(), first);
    advance(15_000);
    timeouts.report('default', timeout(), second);
    expect(first).not.toHaveBeenCalled();

    timeouts.noteStatus('default', { mapName: 'mp_toujane' });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('logs held timeouts when no map was known before them', () => {
    const { timeouts } = setup();
    const emit = vi.fn();

    timeouts.report('default', timeout(), emit);
    timeouts.noteStatus('default', { mapName: 'mp_toujane' });

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('logs held timeouts when the reply names no map', () => {
    const { timeouts } = setup();
    const emit = vi.fn();
    timeouts.noteStatus('default', { mapName: 'mp_toujane' });

    timeouts.report('default', timeout(), emit);
    timeouts.noteStatus('default', {});

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('logs everything once the server stays silent past the grace period', () => {
    const { timeouts, advance } = setup();
    const early = vi.fn();
    const late = vi.fn();
    const later = vi.fn();
    timeouts.noteStatus('default', { mapName: 'mp_toujane' });

    timeouts.report('default', timeout(), early);
    advance(MAP_CHANGE_GRACE_MS - 1);
    timeouts.report('default', timeout(), vi.fn());
    expect(early).not.toHaveBeenCalled();

    advance(1);
    timeouts.report('default', timeout(), late);
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);

    timeouts.report('default', timeout(), later);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('does not log twice when a silent server comes back', () => {
    const { timeouts, advance } = setup();
    const emit = vi.fn();
    timeouts.noteStatus('default', { mapName: 'mp_toujane' });

    timeouts.report('default', timeout(), emit);
    advance(MAP_CHANGE_GRACE_MS);
    timeouts.report('default', timeout(), emit);
    expect(emit).toHaveBeenCalledTimes(2);

    timeouts.noteStatus('default', { mapName: 'mp_toujane' });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('starts over after the server answers', () => {
    const { timeouts, advance } = setup();
    timeouts.noteStatus('default', { mapName: 'mp_toujane' });
    timeouts.report('default', timeout(), vi.fn());
    advance(MAP_CHANGE_GRACE_MS);
    timeouts.report('default', timeout(), vi.fn());
    timeouts.noteStatus('default', { mapName: 'mp_toujane' });

    const emit = vi.fn();
    timeouts.report('default', timeout(), emit);
    expect(emit).not.toHaveBeenCalled();
    timeouts.noteStatus('default', { mapName: 'mp_decoy' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('logs other errors at once', () => {
    const { timeouts } = setup();
    const emit = vi.fn();

    timeouts.report('default', new Error('Bad rcon password'), emit);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('keeps servers apart', () => {
    const { timeouts } = setup();
    const one = vi.fn();
    const two = vi.fn();
    timeouts.noteStatus('one', { mapName: 'mp_toujane' });
    timeouts.noteStatus('two', { mapName: 'mp_toujane' });

    timeouts.report('one', timeout(), one);
    timeouts.report('two', timeout(), two);
    timeouts.noteStatus('one', { mapName: 'mp_decoy' });
    timeouts.noteStatus('two', { mapName: 'mp_toujane' });

    expect(one).not.toHaveBeenCalled();
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('forgets a removed server', () => {
    const { timeouts } = setup();
    const emit = vi.fn();
    timeouts.noteStatus('default', { mapName: 'mp_toujane' });
    timeouts.report('default', timeout(), emit);

    timeouts.forget('default');
    timeouts.noteStatus('default', { mapName: 'mp_decoy' });

    expect(emit).not.toHaveBeenCalled();
  });
});

describe('reportRconError', () => {
  it('logs at once without a tracker', () => {
    const emit = vi.fn();
    reportRconError(undefined, 'default', timeout(), emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
