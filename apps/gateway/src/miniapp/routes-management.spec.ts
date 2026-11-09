import {
  ADMIN_PERMISSIONS,
  MODERATOR_PERMISSIONS,
  OWNER_GRANTED_PERMISSIONS,
  PERMISSIONS,
  type Permission,
} from '@cod2admin/admin-store';
import { UdpQueryTimeoutError } from '@cod2admin/rcon-client';
import type { FastifyInstance } from 'fastify';
// Brings in the type of `injectWS`, which the plugin adds to every Fastify instance.
import type {} from '@fastify/websocket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_ACCESS,
  MODERATOR_ACCESS,
  OWNER_ACCESS,
  sampleAdmin,
  sampleReport,
} from '../lib/testing/fake-admin-store.js';
import { createFakeDeps, type FakeDeps } from '../lib/testing/fake-deps.js';
import { summarizeSnapshots } from './dashboard.js';
import { signInitData } from './init-data.js';
import { parsePresets } from './routes-management.js';
import { createMiniAppServer } from './server.js';
import type { MiniAppIntegrations } from './state.js';
import { takeSnapshots } from '../lib/snapshot-poller.js';

const applyUpdate = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../lib/update-apply.js', () => ({
  downloadReleaseAsset: vi.fn().mockResolvedValue(undefined),
  verifyChecksum: vi.fn().mockResolvedValue(true),
  runApplyUpdate: applyUpdate.run,
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const TOKEN = '123456:TEST-token';
const OWNER = 1;
const ADMIN = 2;
const OTHER_ADMIN = 4;
const MODERATOR = 3;
const OTHER_MODERATOR = 5;

function auth(telegramId: number) {
  const initData = signInitData(
    {
      user: JSON.stringify({
        id: telegramId,
        username: 'kim',
        first_name: 'Kim',
      }),
      auth_date: String(Math.floor(Date.now() / 1000)),
    },
    TOKEN,
  );
  return { authorization: `tma ${initData}` };
}

function setup(): FakeDeps {
  const fake = createFakeDeps();
  const shapes: Record<
    number,
    { isOwner: boolean; permissions: Permission[] }
  > = {
    [OWNER]: OWNER_ACCESS,
    [ADMIN]: ADMIN_ACCESS,
    [OTHER_ADMIN]: ADMIN_ACCESS,
    [MODERATOR]: MODERATOR_ACCESS,
    [OTHER_MODERATOR]: MODERATOR_ACCESS,
  };
  const admins = Object.entries(shapes).map(([id, access]) =>
    sampleAdmin({
      telegramId: Number(id),
      ...access,
      username: 'kim',
      firstName: 'Kim',
    }),
  );
  fake.adminStore.getAdmin.mockImplementation(async (id) =>
    admins.find((admin) => admin.telegramId === id),
  );
  fake.adminStore.listAdmins.mockResolvedValue(admins);
  const settings = new Map<string, unknown>();
  fake.adminStore.getSetting.mockImplementation(async (key) =>
    settings.get(key),
  );
  fake.adminStore.setSetting.mockImplementation(async (key, value) => {
    settings.set(key, value);
  });
  return fake;
}

describe('Mini App management routes', () => {
  let app: FastifyInstance | undefined;
  let fake: FakeDeps;

  beforeEach(() => {
    fake = setup();
    applyUpdate.run.mockReset();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    as: number,
    payload?: object,
    integrations?: MiniAppIntegrations,
  ) {
    app ??= await createMiniAppServer(fake.deps, {
      botToken: TOKEN,
      integrations,
    });
    return app.inject({
      method,
      url: `/api${url}`,
      headers: auth(as),
      ...(payload ? { payload } : {}),
    });
  }

  describe('permission gates (same as the chat commands, docs/PLAN.md §4)', () => {
    it.each([
      ['GET', '/audit', ADMIN],
      ['GET', '/relays', ADMIN],
      ['GET', '/templates', ADMIN],
      ['GET', '/update', ADMIN],
      ['POST', '/update', ADMIN],
      ['DELETE', '/servers/other', ADMIN],
      ['POST', '/servers/default/cvars', ADMIN],
      ['POST', '/servers/default/log', ADMIN],
      ['GET', '/admins', MODERATOR],
      ['GET', '/vpn', MODERATOR],
      ['GET', '/known', MODERATOR],
      ['PUT', '/presets', MODERATOR],
      ['POST', '/servers/default/level', MODERATOR],
      ['PUT', '/servers/default/rotation', MODERATOR],
      ['GET', '/servers/default/cvars', MODERATOR],
    ] as const)(
      '%s %s refuses a caller without that permission',
      async (method, url, as) => {
        const response = await call(
          method,
          url,
          as,
          method === 'GET' ? undefined : {},
        );

        expect(response.statusCode).toBe(403);
      },
    );
  });

  describe('game-chat lines', () => {
    it('shows the built-in lines and applies a change at once', async () => {
      const listed = await call('GET', '/templates', OWNER);
      expect(listed.statusCode).toBe(200);
      const lines = listed.json().lines as {
        id: string;
        text: string;
        preview: string;
      }[];
      expect(lines.find((line) => line.id === 'vpn_kick')?.text).toBe('');
      expect(lines.find((line) => line.id === 'kick')?.preview).toBe(
        'Player was kicked by an admin',
      );

      const saved = await call('PUT', '/templates', OWNER, {
        texts: { vpn_kick: '{name} out: {kind}', kick: '' },
      });
      expect(saved.statusCode).toBe(200);
      const next = saved.json().lines as {
        id: string;
        text: string;
        preview: string;
      }[];
      expect(next.find((line) => line.id === 'vpn_kick')).toMatchObject({
        text: '{name} out: {kind}',
        preview: 'Player out: VPN',
      });
      expect(next.find((line) => line.id === 'kick')?.preview).toBe('');
      expect(fake.deps.chatTemplates.get('ban')).toContain('banned');
      expect(fake.adminStore.setSetting).toHaveBeenCalledWith(
        'chat.templates',
        expect.objectContaining({ vpn_kick: '{name} out: {kind}', kick: '' }),
      );

      const bad = await call('PUT', '/templates', OWNER, {
        texts: { kick: 1 },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('admins', () => {
    function staff(telegramId: number, permissions: Permission[]) {
      return sampleAdmin({
        telegramId,
        isOwner: false,
        permissions,
        username: 'kim',
        firstName: 'Kim',
      });
    }

    it('adds staff with the permissions the caller may grant', async () => {
      const added = await call('POST', '/admins', ADMIN, {
        telegramId: 50,
        permissions: ['kick', 'tempban'],
      });
      expect(added.statusCode).toBe(201);
      expect(fake.adminStore.addAdmin).toHaveBeenCalledWith(
        50,
        ['kick', 'tempban'],
        ADMIN,
      );
      expect(fake.adminStore.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'addadmin',
          target: '50',
          source: 'miniapp',
        }),
      );
    });

    it('refuses a new grant of rcon from anyone but the owner, and an unknown id', async () => {
      const refused = await call('POST', '/admins', ADMIN, {
        telegramId: 51,
        permissions: ['rcon'],
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().message).toContain(
        'Only the owner can grant rcon.',
      );
      expect(fake.adminStore.addAdmin).not.toHaveBeenCalled();

      const unknown = await call('POST', '/admins', OWNER, {
        telegramId: 52,
        permissions: ['not-real'],
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().message).toBe('Unknown permission: not-real');
      expect(fake.adminStore.addAdmin).not.toHaveBeenCalled();
    });

    it('lets the owner grant rcon to someone new, including an empty list', async () => {
      expect(
        (
          await call('POST', '/admins', OWNER, {
            telegramId: 50,
            permissions: ['rcon', 'kick'],
          })
        ).statusCode,
      ).toBe(201);
      expect(fake.adminStore.addAdmin).toHaveBeenCalledWith(
        50,
        ['rcon', 'kick'],
        OWNER,
      );

      expect(
        (
          await call('POST', '/admins', ADMIN, {
            telegramId: 51,
            permissions: [],
          })
        ).statusCode,
      ).toBe(201);
      expect(fake.adminStore.addAdmin).toHaveBeenCalledWith(51, [], ADMIN);
    });

    it('does not change someone who is already staff', async () => {
      const response = await call('POST', '/admins', OWNER, {
        telegramId: ADMIN,
        permissions: ['kick'],
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain('already staff');
      expect(fake.adminStore.addAdmin).not.toHaveBeenCalled();
      expect(fake.adminStore.setPermissions).not.toHaveBeenCalled();

      expect(
        (
          await call('POST', '/admins', OWNER, {
            telegramId: -5,
            permissions: ['kick'],
          })
        ).statusCode,
      ).toBe(400);
    });

    it.each([
      ['the owner', ADMIN, OWNER],
      ['themselves', ADMIN, ADMIN],
      ['themselves as owner', OWNER, OWNER],
    ])(
      'an actor cannot remove or change permissions of %s',
      async (_who, actor, target) => {
        expect(
          (await call('DELETE', `/admins/${target}`, actor)).statusCode,
        ).toBe(403);
        expect(
          (
            await call('PATCH', `/admins/${target}`, actor, {
              permissions: ['kick'],
            })
          ).statusCode,
        ).toBe(403);
        expect(fake.adminStore.removeAdmin).not.toHaveBeenCalled();
        expect(fake.adminStore.setPermissions).not.toHaveBeenCalled();
      },
    );

    it('refuses a moderator-shaped actor on the admins routes', async () => {
      const response = await call('GET', '/admins', MODERATOR);
      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe(
        'This needs the admins.manage permission.',
      );
    });

    it('403s when a holder of rcon tries to newly grant it, and keeps it when omitted', async () => {
      const granter = staff(8, ['admins.manage', 'rcon', 'kick']);
      const without = staff(9, ['kick']);
      const withRcon = staff(10, ['kick', 'rcon']);
      const original = fake.adminStore.getAdmin.getMockImplementation()!;
      fake.adminStore.getAdmin.mockImplementation(async (id) => {
        if (id === 8) return granter;
        if (id === 9) return without;
        if (id === 10) return withRcon;
        return original(id);
      });

      const refused = await call('PATCH', '/admins/9', 8, {
        permissions: ['kick', 'rcon'],
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().message).toContain(
        'Only the owner can grant rcon.',
      );
      expect(fake.adminStore.setPermissions).not.toHaveBeenCalled();

      const kept = await call('PATCH', '/admins/10', ADMIN, {
        permissions: ['kick'],
      });
      expect(kept.statusCode).toBe(200);
      expect(fake.adminStore.setPermissions).toHaveBeenCalledWith(10, [
        'kick',
        'rcon',
      ]);
    });

    it('lets the owner add and remove rcon', async () => {
      let stored: Permission[] = ['kick'];
      fake.adminStore.getAdmin.mockImplementation(async (id) => {
        if (id === OWNER) {
          return sampleAdmin({
            telegramId: OWNER,
            ...OWNER_ACCESS,
            username: 'kim',
            firstName: 'Kim',
          });
        }
        if (id === 9) return staff(9, stored);
        return undefined;
      });
      fake.adminStore.setPermissions.mockImplementation(
        async (_id, permissions) => {
          stored = [...permissions];
        },
      );

      expect(
        (
          await call('PATCH', '/admins/9', OWNER, {
            permissions: ['kick', 'rcon'],
          })
        ).statusCode,
      ).toBe(200);
      expect(fake.adminStore.setPermissions).toHaveBeenCalledWith(9, [
        'kick',
        'rcon',
      ]);

      expect(
        (await call('PATCH', '/admins/9', OWNER, { permissions: ['kick'] }))
          .statusCode,
      ).toBe(200);
      expect(fake.adminStore.setPermissions).toHaveBeenLastCalledWith(9, [
        'kick',
      ]);
    });

    it("refuses a permission the caller doesn't hold", async () => {
      const response = await call('PATCH', `/admins/${MODERATOR}`, ADMIN, {
        permissions: ['audit'],
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe("You can't grant audit.");
      expect(fake.adminStore.setPermissions).not.toHaveBeenCalled();
    });

    it('says who the asker may manage, owner first', async () => {
      const body = (await call('GET', '/admins', ADMIN)).json();

      expect(body.catalog).toEqual([...PERMISSIONS]);
      expect(body.templates).toEqual([
        { id: 'moderator', permissions: [...MODERATOR_PERMISSIONS] },
        { id: 'admin', permissions: [...ADMIN_PERMISSIONS] },
      ]);
      expect(body.ownerGranted).toEqual([...OWNER_GRANTED_PERMISSIONS]);
      expect(body.admins[0]).toMatchObject({
        telegramId: OWNER,
        isOwner: true,
        permissions: [...PERMISSIONS],
        manageable: false,
      });
      expect(
        body.admins.map(
          (admin: { telegramId: number; manageable: boolean }) => [
            admin.telegramId,
            admin.manageable,
          ],
        ),
      ).toEqual([
        [OWNER, false],
        [ADMIN, false],
        [MODERATOR, true],
        [OTHER_ADMIN, true],
        [OTHER_MODERATOR, true],
      ]);
    });
  });

  describe('servers', () => {
    beforeEach(() => {
      fake.adminStore.listServers.mockResolvedValue([
        {
          alias: 'default',
          rconHost: '10.0.0.1',
          rconPort: 28960,
          rconPassword: 'hunter2',
          logSourceConfig: null,
          boundTelegramChatId: null,
          isDefault: false,
        },
      ]);
      fake.rcon.getStatus.mockResolvedValue({
        cvars: {
          sv_maxclients: '40',
          mapname: 'mp_toujane',
          g_gametype: 'ctf',
          sv_hostname: '^1Red',
        },
        players: [],
      });
    });

    it('never sends the RCON password, and shows the address to admins only', async () => {
      const asAdmin = await call('GET', '/servers', ADMIN);
      expect(asAdmin.body).not.toContain('hunter2');
      expect(asAdmin.json().servers[0]).toMatchObject({
        hostname: 'Red',
        maxClients: 40,
        connection: { host: '10.0.0.1', fromConfig: true },
      });

      const asModerator = await call('GET', '/servers', MODERATOR);
      expect(asModerator.json().servers[0].connection).toBeUndefined();
    });

    it('marks a server that does not answer as offline', async () => {
      fake.rcon.getStatus.mockRejectedValue(
        new UdpQueryTimeoutError('getstatus'),
      );

      expect(
        (await call('GET', '/servers', OWNER)).json().servers[0],
      ).toMatchObject({ online: false, players: 0 });
    });

    it('saves nothing when the password is rejected, and keeps it out of the audit log', async () => {
      const candidate = { status: vi.fn() };
      fake.deps.createRconClient = () => candidate as never;
      candidate.status.mockResolvedValue({
        raw: 'Bad rcon password',
        players: [],
      });
      const payload = {
        alias: 'ctf2',
        host: '10.0.0.2',
        port: 28960,
        password: 'pw',
      };

      expect((await call('POST', '/servers', OWNER, payload)).statusCode).toBe(
        422,
      );
      expect(fake.adminStore.upsertServer).not.toHaveBeenCalled();

      candidate.status.mockResolvedValue({
        raw: '',
        players: [],
        mapName: 'mp_harbor',
      });
      expect((await call('POST', '/servers', OWNER, payload)).statusCode).toBe(
        201,
      );
      expect(fake.deps.rconClients.has('ctf2')).toBe(true);
      expect(
        JSON.stringify(fake.adminStore.recordAuditLog.mock.calls),
      ).not.toContain('"pw"');
    });

    it('refuses a password with a space, and touching the config-file server', async () => {
      const spaced = { alias: 'x', host: 'h', port: 1, password: 'a b' };
      expect((await call('POST', '/servers', OWNER, spaced)).statusCode).toBe(
        400,
      );
      expect(
        (
          await call('POST', '/servers', OWNER, {
            ...spaced,
            alias: 'default',
            password: 'p',
          })
        ).statusCode,
      ).toBe(409);
      expect((await call('DELETE', '/servers/default', OWNER)).statusCode).toBe(
        409,
      );
      expect(fake.adminStore.removeServer).not.toHaveBeenCalled();
    });
  });

  describe('map rotation and level commands', () => {
    it('sets the rotation, grouping modes, when the server took it whole', async () => {
      const entries = [
        { map: 'mp_toujane', gametype: 'ctf' },
        { map: 'mp_harbor', gametype: 'ctf' },
        { map: 'mp_toujane', gametype: 'hq' },
      ];
      fake.rcon.getMapRotationEntries
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(entries);

      expect(
        (await call('PUT', '/servers/default/rotation', ADMIN, { entries }))
          .statusCode,
      ).toBe(200);
      expect(fake.rcon.setCvar).toHaveBeenNthCalledWith(
        1,
        'sv_mapRotation',
        'gametype ctf map mp_toujane map mp_harbor gametype hq map mp_toujane',
      );
      expect(fake.rcon.setCvar).toHaveBeenNthCalledWith(
        2,
        'sv_mapRotationCurrent',
        '',
      );
    });

    it('puts the old rotation back when the server did not take the new one', async () => {
      const before = [{ map: 'mp_old', gametype: 'tdm' }];
      fake.rcon.getMapRotationEntries
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce([]);

      const response = await call('PUT', '/servers/default/rotation', ADMIN, {
        entries: [{ map: 'mp_toujane', gametype: 'ctf' }],
      });

      expect(response.statusCode).toBe(422);
      expect(fake.rcon.setCvar).toHaveBeenLastCalledWith(
        'sv_mapRotation',
        'gametype tdm map mp_old',
      );
    });

    it.each([
      [{ entries: [] }],
      [{ entries: [{ map: 'mp_a; quit', gametype: 'ctf' }] }],
      [
        {
          entries: [
            { map: 'mp_a', gametype: 'ctf' },
            { map: 'mp_a', gametype: 'ctf' },
          ],
        },
      ],
    ])('refuses a bad rotation %#', async (payload) => {
      expect(
        (await call('PUT', '/servers/default/rotation', ADMIN, payload))
          .statusCode,
      ).toBe(400);
      expect(fake.rcon.setCvar).not.toHaveBeenCalled();
    });

    it('tells from the map whether a silent rotate worked, as a real server never answers it', async () => {
      fake.rcon.levelCommand.mockResolvedValue(false);
      const rotate = () =>
        call('POST', '/servers/default/level', ADMIN, { command: 'rotate' });

      fake.rcon.getInfo
        .mockResolvedValueOnce({ mapname: 'mp_a' })
        .mockResolvedValueOnce({ mapname: 'mp_b' });
      expect((await rotate()).json().message).toBe('Now on mp_b.');

      fake.rcon.getInfo
        .mockResolvedValueOnce({ mapname: 'mp_a' })
        .mockResolvedValueOnce({ mapname: 'mp_a' });
      expect((await rotate()).json().message).toContain('still on mp_a');

      fake.rcon.getInfo
        .mockResolvedValueOnce({ mapname: 'mp_a' })
        .mockRejectedValueOnce(new UdpQueryTimeoutError('x'));
      expect((await rotate()).json().message).toContain("hasn't come back");
    });

    it('runs only known level commands', async () => {
      await call('POST', '/servers/default/level', ADMIN, {
        command: 'rotate',
      });
      expect(fake.rcon.levelCommand).toHaveBeenCalledWith('map_rotate');

      for (const command of ['quit', 'constructor', '__proto__']) {
        expect(
          (await call('POST', '/servers/default/level', ADMIN, { command }))
            .statusCode,
        ).toBe(400);
      }
      expect(fake.rcon.levelCommand).toHaveBeenCalledTimes(1);
    });
  });

  describe('cvars', () => {
    it('refuses rcon_password and bad names, and strips what could end the command', async () => {
      const set = (name: string, value = '1') =>
        call('POST', '/servers/default/cvars', OWNER, { name, value });

      expect((await set('RCON_PASSWORD')).statusCode).toBe(400);
      expect((await set('a b')).statusCode).toBe(400);
      expect((await set('sv_hostname', 'x; quit')).statusCode).toBe(200);
      expect(fake.rcon.setCvar).toHaveBeenCalledTimes(1);
      expect(fake.rcon.setCvar.mock.calls[0]![1]).not.toContain(';');
    });
  });

  describe('reports', () => {
    it('lists open reports with the players they could be about', async () => {
      fake.adminStore.searchReports.mockResolvedValue([
        sampleReport({ targetName: 'cheat' }),
      ]);
      fake.rcon.status.mockResolvedValue({
        raw: '',
        players: [
          { num: 3, name: '^1Cheater', score: 0, ping: 1, ip: '203.0.113.7' },
          { num: 4, name: 'Honest', score: 0, ping: 1 },
        ],
      });

      const { items } = (await call('GET', '/reports', MODERATOR)).json();

      expect(
        items[0].candidates.map((player: { num: number }) => player.num),
      ).toEqual([3]);
    });

    it('closes a report and its Telegram card, and audits it', async () => {
      fake.adminStore.resolveReport.mockResolvedValue(
        sampleReport({ status: 'ignored', outcome: 'Ignored' }),
      );
      const closeReportCard = vi.fn().mockResolvedValue(undefined);

      const response = await call(
        'POST',
        '/reports/1/resolve',
        MODERATOR,
        { status: 'ignored' },
        { closeReportCard },
      );

      expect(response.statusCode).toBe(200);
      expect(fake.adminStore.resolveReport).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'ignored', resolvedBy: MODERATOR }),
      );
      expect(closeReportCard).toHaveBeenCalledWith(
        1,
        expect.stringContaining('Ignored'),
      );
      expect(fake.adminStore.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'report_ignored',
          target: 'Cheater',
        }),
      );
    });

    it('answers 409 when someone else got there first, and a failing card does not fail the action', async () => {
      expect(
        (
          await call('POST', '/reports/1/resolve', MODERATOR, {
            status: 'handled',
          })
        ).statusCode,
      ).toBe(409);

      fake.adminStore.resolveReport.mockResolvedValue(
        sampleReport({ status: 'handled' }),
      );
      await app?.close();
      app = undefined;
      const response = await call(
        'POST',
        '/reports/1/resolve',
        MODERATOR,
        { status: 'handled' },
        { closeReportCard: vi.fn().mockRejectedValue(new Error('no route')) },
      );
      expect(response.statusCode).toBe(200);
    });
  });

  describe('notes', () => {
    const stored = {
      id: 7,
      kind: 'name' as const,
      value: 'bob',
      note: 'rude',
      watch: false,
      createdBy: MODERATOR,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('files a name without colours or case, and refuses GUID 0', async () => {
      fake.adminStore.addPlayerNote.mockResolvedValue(stored);

      await call('POST', '/notes', MODERATOR, {
        kind: 'name',
        value: '^1BoB ',
        note: ' rude ',
        watch: true,
      });
      expect(fake.adminStore.addPlayerNote).toHaveBeenCalledWith({
        kind: 'name',
        value: 'bob',
        note: 'rude',
        watch: true,
        createdBy: MODERATOR,
      });
      expect(
        (
          await call('POST', '/notes', MODERATOR, {
            kind: 'guid',
            value: '0',
            note: 'x',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call('POST', '/notes', MODERATOR, {
            kind: 'name',
            value: 'bob',
            note: '  ',
          })
        ).statusCode,
      ).toBe(400);
    });

    it("keeps a moderator off someone else's note, but not an admin", async () => {
      fake.adminStore.getPlayerNote.mockResolvedValue(stored);
      fake.adminStore.deletePlayerNote.mockResolvedValue(true);

      expect(
        (await call('DELETE', '/notes/7', OTHER_MODERATOR)).statusCode,
      ).toBe(403);
      expect(fake.adminStore.deletePlayerNote).not.toHaveBeenCalled();
      expect((await call('DELETE', '/notes/7', MODERATOR)).statusCode).toBe(
        200,
      );
      expect((await call('DELETE', '/notes/7', ADMIN)).statusCode).toBe(200);
    });

    it('marks watched and noted players in the live status, and notices a new note', async () => {
      fake.rcon.status.mockResolvedValue({
        raw: '',
        players: [
          { num: 1, name: '^2BoB', score: 0, ping: 1 },
          { num: 2, name: 'Eve', score: 0, ping: 1, ip: '203.0.113.7' },
          { num: 3, name: 'Clean', score: 0, ping: 1 },
        ],
      });
      fake.adminStore.searchPlayerNotes.mockResolvedValue([
        stored,
        { ...stored, id: 8, kind: 'ip', value: '203.0.113.7', watch: true },
      ]);

      const { players } = (
        await call('GET', '/servers/default/status', MODERATOR)
      ).json();
      expect(players[0]).toMatchObject({ noted: true });
      expect(players[0].watched).toBeUndefined();
      expect(players[1]).toMatchObject({ noted: true, watched: true });
      expect(players[2].noted).toBeUndefined();

      fake.adminStore.addPlayerNote.mockResolvedValue(stored);
      fake.adminStore.searchPlayerNotes.mockResolvedValue([
        { ...stored, value: 'clean' },
      ]);
      await call('POST', '/notes', MODERATOR, {
        kind: 'name',
        value: 'clean',
        note: 'x',
      });
      const after = (
        await call('GET', '/servers/default/status', MODERATOR)
      ).json();
      expect(after.players[2]).toMatchObject({ noted: true });
    });

    it('still lists players when the notes cannot be read', async () => {
      fake.rcon.status.mockResolvedValue({
        raw: '',
        players: [{ num: 1, name: 'A', score: 0, ping: 1 }],
      });
      fake.adminStore.searchPlayerNotes.mockRejectedValue(new Error('db down'));
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      const response = await call('GET', '/servers/default/status', MODERATOR);

      expect(response.statusCode).toBe(200);
      error.mockRestore();
    });
  });

  describe('presets', () => {
    it('gives defaults until someone saves, and cleans what is saved', async () => {
      expect(
        (await call('GET', '/presets', MODERATOR)).json().reasons,
      ).toContain('Cheating');

      const saved = await call('PUT', '/presets', ADMIN, {
        reasons: ['Aim; quit', 'Aim; quit', '', 5],
        durations: [120, 30, 30, -1, 1.5, 9_999_999],
        messages: ['Play fair'],
      });

      expect(saved.json().durations).toEqual([30, 120]);
      expect(saved.json().reasons).toHaveLength(1);
      expect(saved.json().reasons[0]).not.toContain(';');
    });

    it('survives junk in the settings table', () => {
      expect(parsePresets('junk').durations.length).toBeGreaterThan(0);
    });
  });

  describe('VPN rules', () => {
    it('turns the kick on for the running sweep too, and keeps exemptions', async () => {
      const response = await call('PUT', '/vpn/kick', ADMIN, { enabled: true });

      expect(response.json().kickEnabled).toBe(true);
      expect(fake.deps.vpnKick.settings.enabled).toBe(true);

      await call('POST', '/vpn/exempt', ADMIN, { player: '^1Friend' });
      expect(fake.deps.vpnKick.settings.exempt).toEqual(['friend']);
      expect(
        (await call('POST', '/vpn/exempt', ADMIN, { player: 'friend' }))
          .statusCode,
      ).toBe(409);
      await call('POST', '/vpn/exempt/remove', ADMIN, { player: 'friend' });
      expect(fake.deps.vpnKick.settings.exempt).toEqual([]);
    });

    it('adds a network by ASN and applies it, and refuses junk', async () => {
      const setNetworks = vi.spyOn(fake.deps.vpn, 'setNetworks');

      const response = await call('POST', '/vpn/networks', ADMIN, {
        value: 'as202226',
      });

      expect(response.json().networks).toEqual([{ asn: 202226, name: null }]);
      expect(setNetworks).toHaveBeenCalledWith([202226]);
      expect(
        (await call('POST', '/vpn/networks', ADMIN, { value: 'nope' }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe('Known players', () => {
    it('adds names and networks, applies them to the running list and audits', async () => {
      let response = await call('POST', '/known', ADMIN, {
        name: '^1Vasya',
        value: 'AS12389',
      });
      expect(response.json().entries).toEqual([
        {
          name: 'vasya',
          display: '^1Vasya',
          asns: [12389],
          guids: [],
          note: null,
        },
      ]);
      expect(fake.deps.knownPlayers.entries).toHaveLength(1);

      response = await call('POST', '/known', ADMIN, {
        name: 'vasya',
        value: '8359',
      });
      expect(response.json().entries[0].asns).toEqual([12389, 8359]);
      expect(
        (await call('POST', '/known', ADMIN, { name: 'vasya', value: '8359' }))
          .statusCode,
      ).toBe(409);
      expect(
        (await call('POST', '/known', ADMIN, { name: 'vasya', value: 'nope' }))
          .statusCode,
      ).toBe(400);
      expect(
        (await call('POST', '/known', ADMIN, { name: '', value: 'AS1' }))
          .statusCode,
      ).toBe(400);
      expect(fake.adminStore.recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'known_add',
          target: 'vasya',
          source: 'miniapp',
        }),
      );
    });

    it('resolves a player IP to its network', async () => {
      fake.deps.provider = {
        lookup: () => undefined,
        asn: (ip) => (ip === '1.1.1.1' ? 12389 : undefined),
      };
      const ok = await call('POST', '/known', ADMIN, {
        name: 'a',
        value: '1.1.1.1',
      });
      expect(ok.json().entries[0].asns).toEqual([12389]);
      expect(
        (await call('POST', '/known', ADMIN, { name: 'b', value: '9.9.9.9' }))
          .statusCode,
      ).toBe(422);
    });

    it('removes a network but never the last one, edits the note, deletes the entry', async () => {
      await call('POST', '/known', ADMIN, { name: 'vasya', value: 'AS1' });
      await call('POST', '/known', ADMIN, { name: 'vasya', value: 'AS2' });

      let response = await call('POST', '/known/asn/remove', ADMIN, {
        name: 'vasya',
        asn: 1,
      });
      expect(response.json().entries[0].asns).toEqual([2]);
      expect(
        (
          await call('POST', '/known/asn/remove', ADMIN, {
            name: 'vasya',
            asn: 2,
          })
        ).statusCode,
      ).toBe(409);

      response = await call('POST', '/known/note', ADMIN, {
        name: 'Vasya',
        note: ' home ',
      });
      expect(response.json().entries[0].note).toBe('home');

      response = await call('POST', '/known/remove', ADMIN, { name: 'vasya' });
      expect(response.json().entries).toEqual([]);
      expect(
        (await call('POST', '/known/remove', ADMIN, { name: 'vasya' }))
          .statusCode,
      ).toBe(404);
    });

    it('adds and removes GUIDs, never leaving an entry empty', async () => {
      await call('POST', '/known', ADMIN, { name: 'vasya', value: 'AS1' });
      let response = await call('POST', '/known', ADMIN, {
        name: 'vasya',
        value: 'guid:716922',
      });
      expect(response.json().entries[0]).toMatchObject({
        asns: [1],
        guids: ['716922'],
      });
      expect(
        (
          await call('POST', '/known', ADMIN, {
            name: 'vasya',
            value: 'guid:716922',
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call('POST', '/known', ADMIN, {
            name: 'vasya',
            value: 'guid:0',
          })
        ).statusCode,
      ).toBe(400);

      await call('POST', '/known/asn/remove', ADMIN, { name: 'vasya', asn: 1 });
      expect(
        (
          await call('POST', '/known/guid/remove', ADMIN, {
            name: 'vasya',
            guid: '716922',
          })
        ).statusCode,
      ).toBe(409);
      response = await call('POST', '/known', ADMIN, {
        name: 'vasya',
        value: 'AS2',
      });
      response = await call('POST', '/known/guid/remove', ADMIN, {
        name: 'vasya',
        guid: '716922',
      });
      expect(response.json().entries[0]).toMatchObject({
        asns: [2],
        guids: [],
      });
    });

    it('turns the sweep on and off', async () => {
      const response = await call('PUT', '/known/enabled', ADMIN, {
        enabled: true,
      });
      expect(response.json().enabled).toBe(true);
      expect(fake.deps.knownPlayers.enabled).toBe(true);
    });
  });

  describe('Telegram routes', () => {
    it('checks a relay before saving it', async () => {
      vi.mocked(fake.deps.telegramRoutes.probe).mockResolvedValueOnce({
        ok: false,
        error: 'timeout',
      });
      expect(
        (await call('POST', '/relays', OWNER, { url: 'https://r.example' }))
          .statusCode,
      ).toBe(422);
      expect(fake.adminStore.setSetting).not.toHaveBeenCalled();

      const added = await call('POST', '/relays', OWNER, {
        url: 'https://r.example',
      });
      expect(added.json().relays).toEqual(['https://r.example']);
    });

    it('never removes the last route', async () => {
      expect(
        (await call('PUT', '/relays/direct', OWNER, { direct: false }))
          .statusCode,
      ).toBe(409);
      expect(fake.adminStore.setSetting).not.toHaveBeenCalled();
    });
  });

  describe('self-update', () => {
    const release = (tagName: string) => ({
      tagName,
      notes: 'notes',
      gatewayAsset: { name: 'g.tar.gz', downloadUrl: 'https://x/g' },
      checksumAsset: { name: 'g.sha256', downloadUrl: 'https://x/s' },
    });

    it('reports a GitHub failure instead of failing the page', async () => {
      fake.githubReleaseClient.getLatestRelease.mockRejectedValue(
        new Error('403'),
      );

      expect((await call('GET', '/update', OWNER)).json()).toMatchObject({
        available: false,
        checkError: '403',
      });
    });

    it('applies only the version the owner agreed to, and marks this chat for the report', async () => {
      fake.githubReleaseClient.getLatestRelease.mockResolvedValue(
        release('v99.0.0'),
      );

      expect(
        (await call('POST', '/update', OWNER, { tag: 'v98.0.0' })).statusCode,
      ).toBe(409);
      expect(applyUpdate.run).not.toHaveBeenCalled();

      expect(
        (await call('POST', '/update', OWNER, { tag: 'v99.0.0' })).statusCode,
      ).toBe(200);
      expect(applyUpdate.run).toHaveBeenCalledTimes(1);
      const { writeFile } = await import('node:fs/promises');
      expect(vi.mocked(writeFile).mock.lastCall?.[1]).toContain(
        `CHAT_ID=${OWNER}`,
      );
    });

    it('shows a failed apply on the next look', async () => {
      fake.githubReleaseClient.getLatestRelease.mockResolvedValue(
        release('v99.0.0'),
      );
      await call('POST', '/update', OWNER, { tag: 'v99.0.0' });

      applyUpdate.run.mock.calls[0]![2].onProblem({
        kind: 'failed',
        output: 'sudo: nope',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect((await call('GET', '/update', OWNER)).json().problem).toContain(
        'sudo: nope',
      );
    });

    it('refuses when up to date or the install cannot update itself', async () => {
      fake.githubReleaseClient.getLatestRelease.mockResolvedValue(
        release('v0.0.1'),
      );
      expect(
        (await call('POST', '/update', OWNER, { tag: 'v0.0.1' })).statusCode,
      ).toBe(409);

      fake.deps.updateConfig = undefined;
      expect(
        (await call('POST', '/update', OWNER, { tag: 'v0.0.1' })).statusCode,
      ).toBe(409);
      expect(applyUpdate.run).not.toHaveBeenCalled();
    });
  });

  describe('live feed', () => {
    it('tells an open app about a new report and a closed one', async () => {
      const server = await createMiniAppServer(fake.deps, { botToken: TOKEN });
      app = server;
      await server.ready();
      fake.adminStore.countOpenReports.mockResolvedValue(1);
      const ws = await server.injectWS('/api/ws');
      const messages: {
        type: string;
        openReports?: number;
        added?: unknown;
      }[] = [];
      ws.on('message', (data: Buffer) =>
        messages.push(JSON.parse(data.toString())),
      );
      const waitFor = async (check: () => boolean) => {
        for (let i = 0; i < 100 && !check(); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      ws.send(
        JSON.stringify({
          type: 'auth',
          initData: auth(MODERATOR).authorization.slice(4),
        }),
      );
      await waitFor(() => messages.some((message) => message.type === 'ready'));

      await fake.deps.reportQueue.record('default', {
        chat: { guid: '0', name: 'Honest', num: 1 },
        targetName: 'Cheater',
      } as never);
      await waitFor(() =>
        messages.some((message) => message.type === 'reports'),
      );
      expect(messages.find((message) => message.type === 'reports')).toEqual({
        type: 'reports',
        openReports: 1,
        added: { server: 'default', target: 'Cheater', reporter: 'Honest' },
      });

      fake.adminStore.countOpenReports.mockResolvedValue(0);
      fake.adminStore.resolveReport.mockResolvedValue(
        sampleReport({ status: 'handled' }),
      );
      await fake.deps.reportQueue.resolve(1, {
        status: 'handled',
        resolvedBy: 1,
      });
      await waitFor(
        () =>
          messages.filter((message) => message.type === 'reports').length === 2,
      );
      expect(messages.at(-1)).toEqual({ type: 'reports', openReports: 0 });
      ws.terminate();
    });
  });

  describe('dashboard', () => {
    it('still answers when the server is offline', async () => {
      fake.rcon.getStatus.mockRejectedValue(
        new UdpQueryTimeoutError('getstatus'),
      );

      const response = await call(
        'GET',
        '/servers/default/dashboard?hours=168',
        MODERATOR,
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ online: false, hours: 168 });
    });
  });

  describe('audit log', () => {
    it('passes filters on, ignores an unknown source, and names the bot itself', async () => {
      fake.adminStore.searchAuditLog.mockResolvedValue([
        {
          id: 1,
          actorTelegramId: 0,
          action: 'vpn_kick',
          target: 'X',
          serverAlias: 'default',
          reason: null,
          source: 'auto',
          detailJson: { ip: '1.2.3.4' },
          createdAt: new Date(),
          actorUsername: null,
          actorFirstName: null,
        },
      ]);

      const { items } = (
        await call('GET', '/audit?action=vpn_kick&source=nope&days=7', OWNER)
      ).json();

      expect(items[0].actor).toBe('The bot');
      expect(items[0].detail).toContain('1.2.3.4');
      expect(fake.adminStore.searchAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'vpn_kick',
          source: undefined,
          since: expect.any(Date),
        }),
      );
    });
  });
});

describe('summarizeSnapshots', () => {
  const since = new Date('2026-11-01T00:00:00Z');
  const until = new Date('2026-11-02T00:00:00Z');
  const snapshot = (
    minutes: number,
    online: boolean,
    playerCount = 0,
    map: string | null = null,
  ) => ({
    serverAlias: 'a',
    at: new Date(since.getTime() + minutes * 60_000),
    online,
    playerCount,
    maxClients: 40,
    map,
    gametype: 'ctf',
  });

  it('has nothing to say about a period with no checks', () => {
    expect(summarizeSnapshots([], since, until)).toEqual({
      samples: 0,
      points: [],
      peak: null,
      average: null,
      uptimePercent: null,
      topMaps: [],
    });
  });

  it('works out the peak, average, uptime and most-played maps', () => {
    const summary = summarizeSnapshots(
      [
        snapshot(0, true, 10, 'mp_a'),
        snapshot(100, true, 20, 'mp_a'),
        snapshot(200, true, 0, 'mp_empty'),
        snapshot(300, false),
        snapshot(400, true, 30, 'mp_b'),
      ],
      since,
      until,
    );

    expect(summary.peak?.players).toBe(30);
    expect(summary.average).toBe(15);
    expect(summary.uptimePercent).toBe(80);
    expect(summary.topMaps.map((map) => map.map)).toEqual(['mp_a', 'mp_b']);
    expect(summary.topMaps[0]!.percent).toBeCloseTo(66.67, 1);
  });

  it('keeps the busiest moment of a slice, and shows an outage as a gap, not zero', () => {
    const { points } = summarizeSnapshots(
      [
        snapshot(0, true, 5),
        snapshot(1, true, 9),
        snapshot(2, false),
        snapshot(600, false),
      ],
      since,
      until,
    );

    expect(points.map((point) => point.players)).toEqual([9, null]);
  });
});

describe('takeSnapshots', () => {
  it('records an online server, and an offline one as such, without giving up on the rest', async () => {
    const fake = createFakeDeps();
    fake.rcon.getStatus.mockResolvedValue({
      cvars: { sv_maxclients: '40', mapname: 'mp_a', g_gametype: 'ctf' },
      players: [{ score: 0, ping: 1, name: 'A' }] as never,
    });
    const offline = {
      getStatus: vi.fn().mockRejectedValue(new UdpQueryTimeoutError('x')),
    };
    fake.deps.rconClients.set('down', offline as never);

    await takeSnapshots(fake.deps);

    expect(fake.adminStore.recordServerSnapshot).toHaveBeenCalledWith({
      serverAlias: 'default',
      online: true,
      playerCount: 1,
      maxClients: 40,
      map: 'mp_a',
      gametype: 'ctf',
    });
    expect(fake.adminStore.recordServerSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ serverAlias: 'down', online: false }),
    );
  });
});
