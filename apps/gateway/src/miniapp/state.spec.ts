import { describe, expect, it, vi } from 'vitest';
import type { GatewayDeps } from '../lib/deps.js';
import { MiniAppState, noteNameKey } from './state.js';

function setup(
  cvars: Record<string, string> = { g_gametype: 'ctf' },
  limits: Record<string, string> = {},
) {
  let mapName = 'mp_toujane';
  let rows: { num: number; name: string; ip?: string }[] = [];
  const rcon = {
    status: vi.fn(async () => ({
      hostname: 'h',
      mapName,
      raw: rows
        .map(
          (row) =>
            ` ${row.num}    19  110      0 ${row.name}^7       0 ${row.ip ?? '0.0.0.0'}:28960    1234 25000`,
        )
        .join('\n'),
      players: rows.map((row) => ({
        ...row,
        score: 19,
        ping: 110,
      })),
    })),
    getStatus: vi.fn(async () => ({ cvars, players: [] })),
    // Like the game: the time limit is only reachable by asking for the cvar by name.
    rcon: vi.fn(async (name: string) =>
      name in limits
        ? `"${name}" is:"${limits[name]}^7" default:"0^7"`
        : `"${name}" is:"" default:""`,
    ),
  };
  const getServer = vi.fn(
    async (): Promise<
      { watch?: { enabled: boolean; spectatorName: string } } | undefined
    > => undefined,
  );
  const teams = new Map<number, number>();
  const deps = {
    rconClients: new Map([['main', rcon]]),
    geoip: { lookup: () => undefined },
    provider: { lookup: () => undefined },
    vpn: { lookup: () => undefined },
    adminStore: {
      searchPlayerNotes: vi.fn(async () => []),
      listServerSnapshots: vi.fn(async () => []),
      getServer,
    },
    watchSupervisor: { playerTeams: () => teams },
  } as unknown as GatewayDeps;
  return {
    deps: deps as unknown as {
      adminStore: {
        listServerSnapshots: ReturnType<typeof vi.fn<() => Promise<unknown[]>>>;
      };
    },
    state: new MiniAppState(deps),
    getServer,
    rcon,
    teams,
    setRows: (next: typeof rows) => {
      rows = next;
    },
    changeMap: (name: string) => {
      mapName = name;
    },
  };
}

describe('MiniAppState.fetchStatus name changes', () => {
  it('logs the raw row, without the address, when a slot renames itself on the same IP', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { state, setRows } = setup();
    setRows([{ num: 20, name: 'sorrybro', ip: '203.0.113.7' }]);
    await state.fetchStatus('main');
    expect(warn).not.toHaveBeenCalled();
    setRows([{ num: 20, name: '1sorrybro', ip: '203.0.113.7' }]);
    await state.fetchStatus('main');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('"sorrybro" -> "1sorrybro"');
    expect(message).toContain('<address>');
    expect(message).not.toContain('203.0.113.7');
    warn.mockRestore();
  });

  it('stays quiet when a different player takes the slot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { state, setRows } = setup();
    setRows([{ num: 20, name: 'a', ip: '203.0.113.7' }]);
    await state.fetchStatus('main');
    setRows([{ num: 20, name: 'b', ip: '203.0.113.8' }]);
    await state.fetchStatus('main');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('MiniAppState.fetchStatus map clock', () => {
  const cvars = { g_gametype: 'ctf' };
  const limits = { scr_ctf_timelimit: '20' };

  it('gives no clock for the map running when the gateway started', async () => {
    const { state } = setup(cvars, limits);
    expect(await state.fetchStatus('main')).not.toHaveProperty(
      'timeLimitMinutes',
    );
  });

  it('gives the limit and start once it has seen the map change', async () => {
    const { state, changeMap } = setup(cvars, limits);
    await state.fetchStatus('main');
    changeMap('mp_harbor');
    const status = await state.fetchStatus('main');
    expect(status.timeLimitMinutes).toBe(20);
    expect(Date.parse(status.mapStartedAt ?? '')).not.toBeNaN();
  });

  it('takes the start from the saved snapshots when the gateway missed the change', async () => {
    const { state, deps } = setup(cvars, limits);
    const at = (minutesAgo: number) =>
      new Date(Date.now() - minutesAgo * 60_000);
    deps.adminStore.listServerSnapshots.mockResolvedValue([
      { at: at(9), online: true, map: 'mp_harbor' },
      { at: at(8), online: true, map: 'mp_toujane' },
      { at: at(1), online: true, map: 'mp_toujane' },
    ]);
    const status = await state.fetchStatus('main');
    expect(status.timeLimitMinutes).toBe(20);
    expect(Date.parse(status.mapStartedAt ?? '')).toBeCloseTo(
      at(8).getTime(),
      -3,
    );
  });

  it('gives none for an unlimited map', async () => {
    const { state, changeMap } = setup(
      { g_gametype: 'ctf' },
      { scr_ctf_timelimit: '0' },
    );
    await state.fetchStatus('main');
    changeMap('mp_harbor');
    expect(await state.fetchStatus('main')).not.toHaveProperty(
      'timeLimitMinutes',
    );
  });
});

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

  it('marks the spectator in the Mini App list only while the bot is on', async () => {
    const { state, rcon, getServer } = setup();
    rcon.status.mockResolvedValue({
      hostname: 'h',
      mapName: 'mp_toujane',
      raw: '',
      players: [
        { num: 1, name: '^1PoliceMan', score: 0, ping: 5 },
        { num: 2, name: 'Patient zero', score: 10, ping: 40 },
      ],
    });
    getServer.mockResolvedValue({
      watch: { enabled: true, spectatorName: 'PoliceMan' },
    });

    const on = await state.fetchStatus('main');
    expect(on.players[0]).toMatchObject({ name: '^1PoliceMan', bot: true });
    expect(on.players[1]?.bot).toBeUndefined();

    getServer.mockResolvedValue({
      watch: { enabled: false, spectatorName: 'PoliceMan' },
    });
    const off = await state.fetchStatus('main');
    expect(off.players[0]?.bot).toBeUndefined();
    expect(off.players[1]?.bot).toBeUndefined();
  });

  it('marks Axis, Allies, and spectators only while the bot is on', async () => {
    const { state, rcon, getServer, teams } = setup();
    teams.set(1, 1);
    teams.set(2, 2);
    teams.set(3, 3);
    teams.set(4, 0);
    rcon.status.mockResolvedValue({
      hostname: 'h',
      mapName: 'mp_toujane',
      raw: '',
      players: [
        { num: 1, name: 'A', score: 1, ping: 1 },
        { num: 2, name: 'B', score: 1, ping: 1 },
        { num: 3, name: 'C', score: 1, ping: 1 },
        { num: 4, name: 'D', score: 1, ping: 1 },
      ],
    });
    getServer.mockResolvedValue({
      watch: { enabled: true, spectatorName: 'PoliceMan' },
    });

    const on = await state.fetchStatus('main');
    expect(on.players.map((player) => player.team)).toEqual([
      'axis',
      'allies',
      'spectator',
      undefined,
    ]);

    getServer.mockResolvedValue({
      watch: { enabled: false, spectatorName: 'PoliceMan' },
    });
    const off = await state.fetchStatus('main');
    expect(off.players.every((player) => player.team === undefined)).toBe(true);
  });
});

describe('noteNameKey', () => {
  it.each([
    ['^^11Grinder^7', 'grinder'],
    ['^1Grinder', 'grinder'],
    ['  Grinder ', 'grinder'],
  ])('files %j under %j', (name, expected) => {
    expect(noteNameKey(name)).toBe(expected);
  });
});
