import { describe, expect, it, vi } from 'vitest';
import type { GatewayDeps } from '../lib/deps.js';
import { MiniAppState } from './state.js';

function setup(cvars: Record<string, string> = { g_gametype: 'ctf' }) {
  let mapName = 'mp_toujane';
  const rcon = {
    status: vi.fn(async () => ({ hostname: 'h', mapName, players: [] })),
    getStatus: vi.fn(async () => ({ cvars, players: [] })),
  };
  const deps = {
    rconClients: new Map([['main', rcon]]),
    adminStore: { searchPlayerNotes: vi.fn(async () => []) },
  } as unknown as GatewayDeps;
  return {
    state: new MiniAppState(deps),
    rcon,
    changeMap: (name: string) => {
      mapName = name;
    },
  };
}

describe('MiniAppState.fetchStatus game mode', () => {
  it('reads the mode once per map, not on every poll', async () => {
    const { state, rcon } = setup();
    expect((await state.fetchStatus('main')).gametype).toBe('ctf');
    await state.fetchStatus('main');
    await state.fetchStatus('main');
    expect(rcon.getStatus).toHaveBeenCalledTimes(1);
  });

  it('reads it again when the map changes', async () => {
    const { state, rcon, changeMap } = setup();
    await state.fetchStatus('main');
    changeMap('mp_harbor');
    await state.fetchStatus('main');
    expect(rcon.getStatus).toHaveBeenCalledTimes(2);
  });

  it('still lists the players when the mode cannot be read', async () => {
    const { state, rcon } = setup();
    rcon.getStatus.mockRejectedValue(new Error('timeout'));
    expect(await state.fetchStatus('main')).toMatchObject({
      mapName: 'mp_toujane',
      gametype: null,
    });
  });
});
