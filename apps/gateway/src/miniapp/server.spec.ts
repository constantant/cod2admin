import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdminRole } from '@cod2admin/admin-store';
import type { ChatEvent } from '@cod2admin/log-tailer';
import {
  UdpQueryTimeoutError,
  type StatusPlayer,
} from '@cod2admin/rcon-client';
import type { FastifyInstance } from 'fastify';
// Brings in the type of `injectWS`, which the plugin adds to every Fastify instance.
import type {} from '@fastify/websocket';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleAdmin } from '../lib/testing/fake-admin-store.js';
import { sampleGuidBan } from '../lib/testing/fake-ban-store.js';
import { createFakeDeps, type FakeDeps } from '../lib/testing/fake-deps.js';
import type { LiveServerMessage } from './api-types.js';
import { signInitData } from './init-data.js';
import { createMiniAppServer } from './server.js';

const TOKEN = '123456:TEST-token';
const PLAYER: StatusPlayer = {
  num: 3,
  name: '^1Cheater',
  score: 5,
  ping: 50,
  guid: '0',
  ip: '203.0.113.7',
};

function authHeader(telegramId: number, username = 'kim'): string {
  const initData = signInitData(
    {
      user: JSON.stringify({ id: telegramId, username, first_name: 'Kim' }),
      auth_date: String(Math.floor(Date.now() / 1000)),
    },
    TOKEN,
  );
  return `tma ${initData}`;
}

function setup(
  roles: Record<number, AdminRole> = { 1: 'owner', 2: 'admin', 3: 'moderator' },
) {
  const fake = createFakeDeps();
  const admins = Object.entries(roles).map(([id, role]) =>
    sampleAdmin({
      telegramId: Number(id),
      role,
      username: 'kim',
      firstName: 'Kim',
    }),
  );
  fake.adminStore.getAdmin.mockImplementation(async (id) =>
    admins.find((admin) => admin.telegramId === id),
  );
  fake.adminStore.listAdmins.mockResolvedValue(admins);
  fake.rcon.status.mockResolvedValue({
    raw: '',
    mapName: 'mp_toujane',
    hostname: 'Test server',
    players: [PLAYER],
  });
  return fake;
}

describe('Mini App server', () => {
  let app: FastifyInstance | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function start(
    fake: FakeDeps,
    options: { devTelegramId?: number; staticDir?: string } = {},
  ) {
    app = await createMiniAppServer(fake.deps, { botToken: TOKEN, ...options });
    return app;
  }

  describe('auth (docs/PLAN-miniapp.md §8)', () => {
    it('refuses a request without Telegram initData', async () => {
      const server = await start(setup());

      const response = await server.inject({ method: 'GET', url: '/api/me' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: 'auth_missing',
        message: 'Open this app from the bot in Telegram.',
      });
    });

    it('refuses initData signed with another bot token', async () => {
      const server = await start(setup());
      const forged = signInitData(
        {
          user: JSON.stringify({ id: 1 }),
          auth_date: String(Math.floor(Date.now() / 1000)),
        },
        '9:other',
      );

      const response = await server.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `tma ${forged}` },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe('auth_bad_signature');
    });

    it('refuses a real Telegram user who is not an admin, and tells them their ID', async () => {
      const server = await start(setup());

      const response = await server.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: authHeader(77) },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'not_admin',
        message: expect.stringContaining('77'),
      });
    });

    it('returns the admin, their role and the servers', async () => {
      const fake = setup();
      fake.deps.logTailers.set('default', {
        on: vi.fn(),
        readRecentChat: vi.fn(),
      } as never);
      const server = await start(fake);

      const response = await server.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: authHeader(2) },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        user: { id: 2, username: 'kim', firstName: 'Kim' },
        role: 'admin',
        version: expect.any(String),
        servers: [{ alias: 'default', chat: true }],
        defaultServer: 'default',
      });
    });

    it('lets unsigned requests through as MINIAPP_DEV_TELEGRAM_ID, for the local dev loop only', async () => {
      const server = await start(setup(), { devTelegramId: 1 });

      const response = await server.inject({ method: 'GET', url: '/api/me' });

      expect(response.json()).toEqual(
        expect.objectContaining({ role: 'owner' }),
      );
    });

    it("gates routes by the same roles as the chat commands: a moderator can't ban or open the console", async () => {
      const fake = setup();
      const server = await start(fake);
      const headers = { authorization: authHeader(3) };

      const ban = await server.inject({
        method: 'POST',
        url: '/api/servers/default/players/3/ban',
        headers,
        payload: { name: PLAYER.name },
      });
      const consoleCall = await server.inject({
        method: 'POST',
        url: '/api/servers/default/console',
        headers,
        payload: { command: 'status' },
      });

      expect(ban.statusCode).toBe(403);
      expect(consoleCall.statusCode).toBe(403);
      expect(fake.rcon.kick).not.toHaveBeenCalled();
      expect(fake.rcon.rcon).not.toHaveBeenCalled();
    });

    it('answers unknown API routes with JSON 404', async () => {
      const server = await start(setup());

      const response = await server.inject({
        method: 'GET',
        url: '/api/nope',
        headers: { authorization: authHeader(1) },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('not_found');
    });
  });

  describe('status and moderation (§6.1)', () => {
    it('returns the live status with player details', async () => {
      const server = await start(setup());

      const response = await server.inject({
        method: 'GET',
        url: '/api/servers/default/status',
        headers: { authorization: authHeader(3) },
      });

      expect(response.json()).toEqual({
        server: 'default',
        hostname: 'Test server',
        mapName: 'mp_toujane',
        players: [
          {
            num: 3,
            name: '^1Cheater',
            score: 5,
            ping: 50,
            guid: null,
            ip: '203.0.113.7',
          },
        ],
        fetchedAt: expect.any(String),
      });
    });

    it('404s an unknown server', async () => {
      const server = await start(setup());

      const response = await server.inject({
        method: 'GET',
        url: '/api/servers/nope/status',
        headers: { authorization: authHeader(1) },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('unknown_server');
    });

    it('kicks through the shared moderation code and audit-logs it as miniapp', async () => {
      const fake = setup();
      const server = await start(fake);

      const response = await server.inject({
        method: 'POST',
        url: '/api/servers/default/players/3/kick',
        headers: { authorization: authHeader(3) },
        payload: { name: '^1Cheater' },
      });

      expect(response.json()).toEqual({ message: 'Kicked Cheater.' });
      expect(fake.rcon.kick).toHaveBeenCalledWith('^1Cheater');
      expect(fake.adminStore.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'kick',
          target: '^1Cheater',
          source: 'miniapp',
          actorTelegramId: 3,
        }),
      );
    });

    it('temp-bans a GUID-0 player by IP for the chosen duration', async () => {
      const fake = setup();
      const server = await start(fake);

      const response = await server.inject({
        method: 'POST',
        url: '/api/servers/default/players/3/tempban',
        headers: { authorization: authHeader(3) },
        payload: { name: '^1Cheater', durationMinutes: 120, reason: 'spam' },
      });

      expect(response.json()).toEqual({
        message: 'IP temp-banned (GUID unavailable) Cheater for 2h.',
      });
      expect(fake.banStore.recordIpBan).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '203.0.113.7',
          reason: 'spam',
          bannedBy: 3,
          expiresAt: expect.any(Date),
        }),
      );
    });

    it('refuses to act when the slot now holds someone else', async () => {
      const fake = setup();
      const server = await start(fake);

      const response = await server.inject({
        method: 'POST',
        url: '/api/servers/default/players/3/kick',
        headers: { authorization: authHeader(1) },
        payload: { name: 'SomeoneElse' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'player_changed',
        message: "SomeoneElse isn't in slot 3 any more — refresh the list.",
      });
      expect(fake.rcon.kick).not.toHaveBeenCalled();
    });

    it('rejects a bad tempban duration', async () => {
      const server = await start(setup());

      const response = await server.inject({
        method: 'POST',
        url: '/api/servers/default/players/3/tempban',
        headers: { authorization: authHeader(1) },
        payload: { name: '^1Cheater', durationMinutes: 0 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('turns an unresponsive game server into a 504 with the bot message', async () => {
      const fake = setup();
      fake.rcon.status.mockRejectedValue(new UdpQueryTimeoutError('timeout'));
      const server = await start(fake);

      const response = await server.inject({
        method: 'GET',
        url: '/api/servers/default/status',
        headers: { authorization: authHeader(1) },
      });

      expect(response.statusCode).toBe(504);
      expect(response.json().error).toBe('server_unresponsive');
    });

    it('slows down a user who fires too many actions at once', async () => {
      const fake = setup();
      const server = await start(fake);
      const codes: number[] = [];

      for (let i = 0; i < 22; i++) {
        const response = await server.inject({
          method: 'POST',
          url: '/api/servers/default/say',
          headers: { authorization: authHeader(1) },
          payload: { message: `hi ${i}` },
        });
        codes.push(response.statusCode);
      }

      expect(codes.filter((code) => code === 200)).toHaveLength(20);
      expect(codes.at(-1)).toBe(429);
    });
  });

  describe('maps and console (§6.1)', () => {
    it('lists modes (CTF first), rotation map+mode pairs and every installed map', async () => {
      const fake = setup();
      fake.rcon.getInfo.mockResolvedValue({
        mapname: 'mp_toujane',
        gametype: 'hq',
      });
      fake.rcon.getMapRotationEntries.mockResolvedValue([
        { map: 'mp_toujane', gametype: 'ctf' },
        { map: 'mp_toujane', gametype: 'hq' },
        { map: 'mp_carentan', gametype: 'ctf' },
      ]);
      fake.rcon.getInstalledMaps.mockResolvedValue([
        'mp_carentan',
        'mp_custom',
        'mp_harbor',
        'mp_toujane',
      ]);
      fake.rcon.getGametypes.mockResolvedValue([
        'ctf',
        'dm',
        'hq',
        'sd',
        'tdm',
      ]);
      const server = await start(fake);

      const response = await server.inject({
        method: 'GET',
        url: '/api/servers/default/maps',
        headers: { authorization: authHeader(2) },
      });

      expect(response.json()).toEqual({
        current: 'mp_toujane',
        currentGametype: 'hq',
        gametypes: ['ctf', 'dm', 'hq', 'sd', 'tdm'],
        defaultGametype: 'ctf',
        rotation: [
          { map: 'mp_toujane', gametype: 'ctf' },
          { map: 'mp_toujane', gametype: 'hq' },
          { map: 'mp_carentan', gametype: 'ctf' },
        ],
        maps: [
          { name: 'mp_carentan', stock: true, inRotation: true },
          { name: 'mp_custom', stock: false, inRotation: false },
          { name: 'mp_harbor', stock: true, inRotation: false },
          { name: 'mp_toujane', stock: true, inRotation: true },
        ],
      });
    });

    it('suggests the current mode on a server without CTF, and falls back to the rotation maps', async () => {
      const fake = setup();
      fake.rcon.getInfo.mockResolvedValue({
        mapname: 'mp_harbor',
        gametype: 'tdm',
      });
      fake.rcon.getMapRotationEntries.mockResolvedValue([
        { map: 'mp_harbor', gametype: 'tdm' },
      ]);
      fake.rcon.getInstalledMaps.mockRejectedValue(new Error('no dir'));
      fake.rcon.getGametypes.mockResolvedValue(['dm', 'tdm']);
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const server = await start(fake);

      const body = (
        await server.inject({
          method: 'GET',
          url: '/api/servers/default/maps',
          headers: { authorization: authHeader(2) },
        })
      ).json();

      expect(body.defaultGametype).toBe('tdm');
      expect(body.maps).toEqual([
        { name: 'mp_harbor', stock: true, inRotation: true },
      ]);
      error.mockRestore();
    });

    it("changes the map using the server's spelling, and refuses one that isn't installed", async () => {
      const fake = setup();
      fake.rcon.getInstalledMaps.mockResolvedValue(['mp_Harbor']);
      const server = await start(fake);
      const headers = { authorization: authHeader(2) };

      const ok = await server.inject({
        method: 'POST',
        url: '/api/servers/default/map',
        headers,
        payload: { map: 'MP_HARBOR' },
      });
      const missing = await server.inject({
        method: 'POST',
        url: '/api/servers/default/map',
        headers,
        payload: { map: 'mp_nope' },
      });

      expect(ok.json()).toEqual({ message: 'Changing map to mp_Harbor…' });
      expect(fake.rcon.map).toHaveBeenCalledWith('mp_Harbor', undefined);
      expect(missing.statusCode).toBe(404);
      expect(fake.adminStore.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'map',
          target: 'mp_Harbor',
          source: 'miniapp',
        }),
      );
    });

    it('switches map and mode together, refusing a mode the server lacks', async () => {
      const fake = setup();
      fake.rcon.getInstalledMaps.mockResolvedValue(['mp_toujane']);
      fake.rcon.getGametypes.mockResolvedValue(['ctf', 'hq']);
      const server = await start(fake);
      const headers = { authorization: authHeader(2) };

      const ok = await server.inject({
        method: 'POST',
        url: '/api/servers/default/map',
        headers,
        payload: { map: 'mp_toujane', gametype: 'CTF' },
      });
      const unknown = await server.inject({
        method: 'POST',
        url: '/api/servers/default/map',
        headers,
        payload: { map: 'mp_toujane', gametype: 'zombies' },
      });
      const injected = await server.inject({
        method: 'POST',
        url: '/api/servers/default/map',
        headers,
        payload: { map: 'mp_toujane', gametype: 'ctf;quit' },
      });

      expect(ok.json()).toEqual({
        message: 'Changing map to mp_toujane (CTF)…',
      });
      expect(fake.rcon.map).toHaveBeenCalledTimes(1);
      expect(fake.rcon.map).toHaveBeenCalledWith('mp_toujane', 'ctf');
      expect(fake.adminStore.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'map',
          target: 'mp_toujane (ctf)',
          source: 'miniapp',
        }),
      );
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error).toBe('unknown_gametype');
      expect(injected.statusCode).toBe(400);
    });

    it('runs a raw console command for the owner, on one line', async () => {
      const fake = setup();
      fake.rcon.rcon.mockResolvedValue('map: mp_toujane\n');
      const server = await start(fake);

      const response = await server.inject({
        method: 'POST',
        url: '/api/servers/default/console',
        headers: { authorization: authHeader(1) },
        payload: { command: 'status\nquit' },
      });

      expect(response.json()).toEqual({ output: 'map: mp_toujane\n' });
      expect(fake.rcon.rcon).toHaveBeenCalledWith('status quit');
    });
  });

  describe('chat (§6.2)', () => {
    it('says there is no chat feed on an RCON-only install', async () => {
      const server = await start(setup());

      const response = await server.inject({
        method: 'GET',
        url: '/api/servers/default/chat',
        headers: { authorization: authHeader(3) },
      });

      expect(response.json()).toEqual({ available: false, lines: [] });
    });

    it("returns the log's recent chat, and adds what admins say", async () => {
      const fake = setup();
      const old: ChatEvent = {
        channel: 'say',
        guid: '0',
        num: 3,
        name: 'Kim',
        message: 'hello',
        timestamp: { minutes: 1, seconds: 0 },
        raw: 'r1',
      };
      fake.deps.logTailers.set('default', {
        on: vi.fn(),
        readRecentChat: vi.fn(async () => [old]),
      } as never);
      const server = await start(fake);
      const headers = { authorization: authHeader(2) };

      await server.inject({
        method: 'POST',
        url: '/api/servers/default/say',
        headers,
        payload: { message: 'be nice; "please"' },
      });
      const response = await server.inject({
        method: 'GET',
        url: '/api/servers/default/chat',
        headers,
      });

      expect(fake.rcon.say).toHaveBeenCalledWith('be nice please');
      expect(response.json().lines).toEqual([
        expect.objectContaining({ id: -1, message: 'hello', source: 'game' }),
        expect.objectContaining({
          id: 1,
          message: 'be nice please',
          source: 'admin',
          name: '@kim',
          channel: 'say',
        }),
      ]);
    });

    it('whispers to a connected player with tell', async () => {
      const fake = setup();
      const server = await start(fake);

      const response = await server.inject({
        method: 'POST',
        url: '/api/servers/default/tell',
        headers: { authorization: authHeader(2) },
        payload: { num: 3, name: '^1Cheater', message: 'last warning' },
      });

      expect(response.json()).toEqual({ message: 'Sent to Cheater.' });
      expect(fake.rcon.tell).toHaveBeenCalledWith(3, 'last warning');
    });
  });

  describe('bans (§6.3)', () => {
    it('lists GUID bans a page at a time, naming who banned', async () => {
      const fake = setup();
      fake.banStore.searchBans.mockResolvedValue(
        Array.from({ length: 51 }, (_, i) =>
          sampleGuidBan({ id: i + 1, bannedBy: 2 }),
        ),
      );
      const server = await start(fake);

      const response = await server.inject({
        method: 'GET',
        url: '/api/bans?q=chea&lifted=1&offset=50',
        headers: { authorization: authHeader(2) },
      });

      expect(fake.banStore.searchBans).toHaveBeenCalledWith({
        query: 'chea',
        includeLifted: true,
        limit: 51,
        offset: 50,
      });
      const body = response.json();
      expect(body.more).toBe(true);
      expect(body.items).toHaveLength(50);
      expect(body.items[0]).toEqual(
        expect.objectContaining({
          kind: 'guid',
          guid: 'GUID123',
          name: 'Cheater',
          bannedBy: '@kim (2)',
        }),
      );
    });

    it('lists IP bans', async () => {
      const fake = setup();
      fake.banStore.searchIpBans.mockResolvedValue([
        {
          id: 4,
          serverAlias: 'default',
          ip: '1.2.3.4',
          reason: 'x',
          bannedBy: 0,
          bannedAt: new Date(),
          expiresAt: null,
          unbannedAt: null,
        },
      ]);
      const server = await start(fake);

      const response = await server.inject({
        method: 'GET',
        url: '/api/bans?kind=ip',
        headers: { authorization: authHeader(2) },
      });

      expect(response.json().items).toEqual([
        expect.objectContaining({
          kind: 'ip',
          ip: '1.2.3.4',
          bannedBy: 'bot (automatic)',
        }),
      ]);
    });

    it("making a permanent GUID ban temporary also takes it out of the server's ban.txt", async () => {
      const fake = setup();
      const before = sampleGuidBan({ id: 7, expiresAt: null });
      const expiresAt = new Date(Date.now() + 3_600_000);
      fake.banStore.getBan.mockResolvedValue(before);
      fake.banStore.updateBan.mockResolvedValue({ ...before, expiresAt });
      const server = await start(fake);

      const response = await server.inject({
        method: 'PATCH',
        url: '/api/bans/guid/7',
        headers: { authorization: authHeader(2) },
        payload: { expiresAt: expiresAt.toISOString() },
      });

      expect(response.statusCode).toBe(200);
      expect(fake.banStore.updateBan).toHaveBeenCalledWith(7, { expiresAt });
      expect(fake.rcon.unbanUser).toHaveBeenCalledWith('Cheater');
      expect(fake.adminStore.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'editban', source: 'miniapp' }),
      );
    });

    it('refuses an expiry in the past', async () => {
      const fake = setup();
      fake.banStore.getBan.mockResolvedValue(sampleGuidBan());
      const server = await start(fake);

      const response = await server.inject({
        method: 'PATCH',
        url: '/api/bans/guid/1',
        headers: { authorization: authHeader(2) },
        payload: { expiresAt: '2000-01-01T00:00:00Z' },
      });

      expect(response.statusCode).toBe(400);
      expect(fake.banStore.updateBan).not.toHaveBeenCalled();
    });

    it('lifts several bans at once through the same code as /unban', async () => {
      const fake = setup();
      fake.banStore.unbanIp.mockResolvedValue(1);
      fake.banStore.unbanByGuid.mockResolvedValue([sampleGuidBan()]);
      const server = await start(fake);

      const response = await server.inject({
        method: 'POST',
        url: '/api/bans/unban',
        headers: { authorization: authHeader(2) },
        payload: { targets: ['1.2.3.4', 'GUID123', '1.2.3.4'] },
      });

      expect(response.json()).toEqual({
        results: [
          { target: '1.2.3.4', lifted: 1, unanswered: [] },
          { target: 'GUID123', lifted: 1, unanswered: [] },
        ],
      });
      expect(fake.adminStore.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'unban', source: 'miniapp' }),
      );
    });

    it('adds an IP ban for someone offline, and validates the IP', async () => {
      const fake = setup();
      const server = await start(fake);
      const headers = { authorization: authHeader(2) };

      const ok = await server.inject({
        method: 'POST',
        url: '/api/bans',
        headers,
        payload: {
          kind: 'ip',
          server: 'default',
          ip: '5.6.7.8',
          durationMinutes: 60,
        },
      });
      const bad = await server.inject({
        method: 'POST',
        url: '/api/bans',
        headers,
        payload: { kind: 'ip', server: 'default', ip: '999.1.1.1' },
      });

      expect(ok.statusCode).toBe(201);
      expect(fake.banStore.recordIpBan).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '5.6.7.8',
          serverAlias: 'default',
          expiresAt: expect.any(Date),
        }),
      );
      expect(bad.statusCode).toBe(400);
    });

    it('adds a permanent GUID ban, refusing GUID 0', async () => {
      const fake = setup();
      const server = await start(fake);
      const headers = { authorization: authHeader(2) };

      const ok = await server.inject({
        method: 'POST',
        url: '/api/bans',
        headers,
        payload: {
          kind: 'guid',
          server: 'default',
          guid: '123456',
          name: 'Cheater',
        },
      });
      const zero = await server.inject({
        method: 'POST',
        url: '/api/bans',
        headers,
        payload: { kind: 'guid', server: 'default', guid: '0', name: 'X' },
      });

      expect(ok.statusCode).toBe(201);
      expect(fake.banStore.recordBan).toHaveBeenCalledWith(
        expect.objectContaining({
          guid: '123456',
          name: 'Cheater',
          expiresAt: null,
        }),
      );
      expect(zero.statusCode).toBe(400);
    });
  });

  describe('web app hosting', () => {
    it("serves the built app, and index.html for the app's own routes", async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'miniapp-static-'));
      await writeFile(path.join(dir, 'index.html'), '<html>app</html>');
      await writeFile(path.join(dir, 'main-ABCD1234.js'), 'js');
      await writeFile(path.join(dir, 'chunk-De-zqpfv.js'), 'js');
      const server = await start(setup(), { staticDir: dir });

      const root = await server.inject({ method: 'GET', url: '/' });
      const deepLink = await server.inject({ method: 'GET', url: '/bans' });
      const asset = await server.inject({
        method: 'GET',
        url: '/main-ABCD1234.js',
      });
      const chunk = await server.inject({
        method: 'GET',
        url: '/chunk-De-zqpfv.js',
      });
      const missingAsset = await server.inject({
        method: 'GET',
        url: '/nope.js',
      });

      expect(root.body).toBe('<html>app</html>');
      expect(deepLink.body).toBe('<html>app</html>');
      expect(deepLink.headers['cache-control']).toBe('no-cache');
      expect(asset.headers['cache-control']).toContain('immutable');
      expect(chunk.headers['cache-control']).toContain('immutable');
      expect(missingAsset.statusCode).toBe(404);
    });
  });

  describe('live feed (/api/ws)', () => {
    it('authenticates with the first message, then pushes status and chat for the subscribed server', async () => {
      const fake = setup();
      let emitChat: (chat: ChatEvent) => void = () => undefined;
      fake.deps.logTailers.set('default', {
        on: (_event: string, listener: (chat: ChatEvent) => void) => {
          emitChat = listener;
        },
        readRecentChat: async () => [],
      } as never);
      const server = await start(fake);
      await server.ready();

      const ws = await server.injectWS('/api/ws');
      const messages: LiveServerMessage[] = [];
      ws.on('message', (data: Buffer) =>
        messages.push(JSON.parse(data.toString())),
      );
      const waitFor = async (type: string) => {
        for (
          let i = 0;
          i < 100 && !messages.some((m) => m.type === type);
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return messages.find((m) => m.type === type);
      };

      ws.send(
        JSON.stringify({ type: 'auth', initData: authHeader(3).slice(4) }),
      );
      expect(await waitFor('ready')).toEqual({
        type: 'ready',
        role: 'moderator',
      });

      ws.send(JSON.stringify({ type: 'subscribe', server: 'default' }));
      expect(await waitFor('status')).toEqual({
        type: 'status',
        status: expect.objectContaining({ mapName: 'mp_toujane' }),
      });

      emitChat({
        channel: 'say',
        guid: '0',
        num: 1,
        name: 'A',
        message: 'gg',
        timestamp: { minutes: 0, seconds: 1 },
        raw: 'x',
      });
      expect(await waitFor('chat')).toEqual({
        type: 'chat',
        server: 'default',
        line: expect.objectContaining({ message: 'gg' }),
      });
      ws.terminate();
    });

    it('closes a socket whose first message is not a valid auth', async () => {
      const server = await start(setup());
      await server.ready();

      const ws = await server.injectWS('/api/ws');
      const closed = new Promise<number>((resolve) =>
        ws.on('close', (code: number) => resolve(code)),
      );
      ws.send(JSON.stringify({ type: 'auth', initData: 'user=x&hash=00' }));

      expect(await closed).toBe(4001);
    });
  });
});
