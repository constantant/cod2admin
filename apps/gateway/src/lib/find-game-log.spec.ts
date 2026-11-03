import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findGameLog, parseCvarReply } from './find-game-log.js';
import { asRconClient, createFakeRcon } from './testing/fake-rcon.js';

const LIVE = {
  sv_hostname: 'CTF RUSSIA',
  mapname: 'mp_toujane',
  g_gametype: 'ctf',
};

function logText(cvars: Record<string, string>): string {
  const block = Object.entries(cvars)
    .map(([key, value]) => `\\${key}\\${value}`)
    .join('');
  return `  0:00 InitGame: ${block}\n  0:05 say;0;1;Player;hello\n`;
}

function fakeRcon(replies: Record<string, string> = {}) {
  const rcon = createFakeRcon();
  rcon.getStatus.mockResolvedValue({ cvars: LIVE, players: [] });
  rcon.rcon.mockImplementation(
    async (command) => replies[command] ?? 'Unknown command',
  );
  return asRconClient(rcon);
}

describe('parseCvarReply', () => {
  it('reads the value and drops the color code the server appends', () => {
    expect(
      parseCvarReply('"fs_homepath" is: "/home/cod2^7" default: "/root^7"\n'),
    ).toBe('/home/cod2');
  });

  it('tells an empty value from a reply that has none', () => {
    expect(parseCvarReply('"g_log" is: "^7" default: "games_mp.log^7"')).toBe('');
    expect(parseCvarReply('Bad rcon password.')).toBeUndefined();
  });
});

describe('findGameLog', () => {
  let root: string;

  const put = async (relative: string, text: string) => {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return path;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'find-game-log-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds the log at the path the server reports, without needing the disk search', async () => {
    const path = await put('home/main/games_mp.log', logText(LIVE));
    const rcon = fakeRcon({ fs_homepath: `"fs_homepath" is: "${join(root, 'home')}^7" default: "^7"` });

    const result = await findGameLog(rcon, { root: join(root, 'empty') });

    expect(result.log).toBe(path);
  });

  it('finds a log mounted somewhere else than the Docker path the server reports', async () => {
    const path = await put('cod2-live/main/games_mp.log', logText(LIVE));
    const rcon = fakeRcon({ fs_homepath: '"fs_homepath" is: "/home/cod2/homedir^7" default: "^7"' });

    const result = await findGameLog(rcon, { root });

    expect(result.log).toBe(path);
    expect(result.reportedPath).toBe('/home/cod2/homedir/main/games_mp.log');
  });

  it("ignores another server's log on the same machine", async () => {
    await put('other/main/games_mp.log', logText({ ...LIVE, sv_hostname: 'Other' }));
    const path = await put('ctf/main/games_mp.log', logText(LIVE));

    const result = await findGameLog(fakeRcon(), { root });

    expect(result.log).toBe(path);
    expect(result.possible).toEqual([]);
  });

  it('judges a file by its latest map start, not an older one', async () => {
    await put(
      'a/games_mp.log',
      logText(LIVE) + logText({ ...LIVE, sv_hostname: 'Renamed' }),
    );

    const result = await findGameLog(fakeRcon(), { root });

    expect(result.log).toBeUndefined();
    expect(result.possible).toEqual([]);
  });

  it("doesn't pick a log by itself when it's on a different map, but offers it", async () => {
    const path = await put('a/games_mp.log', logText({ ...LIVE, mapname: 'mp_decoy' }));

    const result = await findGameLog(fakeRcon(), { root });

    expect(result.log).toBeUndefined();
    expect(result.possible).toEqual([path]);
  });

  it('asks instead of guessing when two logs match exactly', async () => {
    const a = await put('a/games_mp.log', logText(LIVE));
    const b = await put('b/games_mp.log', logText(LIVE));

    const result = await findGameLog(fakeRcon(), { root });

    expect(result.log).toBeUndefined();
    expect(result.possible.sort()).toEqual([a, b]);
  });

  it('counts a log reached through a symlink and directly as one file', async () => {
    const path = await put('real/main/games_mp.log', logText(LIVE));
    await symlink(join(root, 'real'), join(root, 'link'));
    const rcon = fakeRcon({ fs_homepath: `"fs_homepath" is: "${join(root, 'link')}^7" default: "^7"` });

    const result = await findGameLog(rcon, { root });

    expect(result.log).toBe(path);
  });

  it('honors a custom g_log file name and fs_game folder', async () => {
    const path = await put('home/mymod/custom.log', logText(LIVE));
    const rcon = fakeRcon({
      fs_homepath: `"fs_homepath" is: "${join(root, 'home')}^7" default: "^7"`,
      fs_game: '"fs_game" is: "mymod^7" default: "^7"',
      g_log: '"g_log" is: "custom.log^7" default: "games_mp.log^7"',
    });

    const result = await findGameLog(rcon, { root: join(root, 'empty') });

    expect(result.log).toBe(path);
  });

  it('reports when the server has logging turned off', async () => {
    const rcon = fakeRcon({ g_log: '"g_log" is: "^7" default: "games_mp.log^7"' });

    const result = await findGameLog(rcon, { root });

    expect(result.loggingOff).toBe(true);
    expect(result.log).toBeUndefined();
  });

  it('says so when a limit stops the search early', async () => {
    await put('a/b/c/games_mp.log', logText(LIVE));

    const result = await findGameLog(fakeRcon(), { root, maxDirs: 1 });

    expect(result.complete).toBe(false);
    expect(result.log).toBeUndefined();
  });
});
