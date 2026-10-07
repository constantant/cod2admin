import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusResponse } from './api-types.js';
import { StatusWatcher } from './status-watcher.js';

function status(mapName: string): StatusResponse {
  return { server: 'default', hostname: null, mapName, players: [], fetchedAt: '2026-10-07T12:00:00.000Z' };
}

describe('StatusWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls only while someone watches, once per interval for everyone', async () => {
    const fetchStatus = vi.fn(async () => status('mp_toujane'));
    const watcher = new StatusWatcher(fetchStatus, 1000);
    expect(fetchStatus).not.toHaveBeenCalled();

    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = watcher.subscribe(first);
    const stopSecond = watcher.subscribe(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith({ ok: true, status: status('mp_toujane') });
    expect(second).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    stopFirst();
    stopSecond();
    expect(watcher.watching).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('gives a late subscriber the latest status right away', async () => {
    const watcher = new StatusWatcher(async () => status('mp_carentan'), 1000);
    watcher.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    const late = vi.fn();
    watcher.subscribe(late);

    expect(late).toHaveBeenCalledWith({ ok: true, status: status('mp_carentan') });
  });

  it('reports a failed poll and does not stack polls behind a slow one', async () => {
    let resolveSlow: (value: StatusResponse) => void = () => undefined;
    const fetchStatus = vi
      .fn<() => Promise<StatusResponse>>()
      .mockRejectedValueOnce(new Error('no answer'))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSlow = resolve)));
    const watcher = new StatusWatcher(fetchStatus, 1000);
    const listener = vi.fn();
    watcher.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledWith({ ok: false, message: 'no answer' });

    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    resolveSlow(status('mp_harbor'));
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenLastCalledWith({ ok: true, status: status('mp_harbor') });
  });

  it('publishes a status fetched elsewhere to watchers only', async () => {
    const watcher = new StatusWatcher(async () => status('mp_toujane'), 1000);
    watcher.publish(status('ignored'));

    const listener = vi.fn();
    watcher.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    watcher.publish(status('mp_rhine'));

    expect(listener).toHaveBeenLastCalledWith({ ok: true, status: status('mp_rhine') });
    expect(listener).not.toHaveBeenCalledWith({ ok: true, status: status('ignored') });
  });
});
