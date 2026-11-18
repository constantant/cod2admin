import type { Permission } from '@cod2admin/admin-store';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_ACCESS,
  sampleAdmin,
} from '../lib/testing/fake-admin-store.js';
import { createFakeDeps, type FakeDeps } from '../lib/testing/fake-deps.js';
import { signInitData } from './init-data.js';
import { createMiniAppServer } from './server.js';

const TOKEN = '123456:TEST-token';
const OWNER = 1;
const MANAGER = 2; // functions.manage + functions.run, granted by the owner
const RUNNER = 3; // functions.run + kick
const PLAIN = 4; // nothing

function auth(telegramId: number) {
  const initData = signInitData(
    {
      user: JSON.stringify({ id: telegramId, username: 'kim', first_name: 'Kim' }),
      auth_date: String(Math.floor(Date.now() / 1000)),
    },
    TOKEN,
  );
  return { authorization: `tma ${initData}` };
}

const GIVE = {
  slug: 'give',
  title: 'Give weapon',
  kind: 'player_action',
  requires: 'kick',
  definition: {
    params: [
      {
        name: 'weapon',
        label: 'Weapon',
        type: 'choice',
        options: [
          { value: 'ak47', label: 'AK-47' },
          { value: 'm1garand', label: 'M1' },
        ],
      },
    ],
    steps: ['scr_give {player} {weapon}'],
  },
};

const SAY = {
  slug: 'shout',
  title: 'Shout',
  kind: 'action',
  definition: {
    params: [{ name: 'msg', label: 'Message', type: 'text' }],
    steps: ['say {msg}', 'say done'],
  },
};

describe('Mini App custom function routes', () => {
  let app: FastifyInstance | undefined;
  let fake: FakeDeps;

  beforeEach(() => {
    fake = createFakeDeps();
    const shapes: Record<number, { isOwner: boolean; permissions: Permission[] }> = {
      [OWNER]: OWNER_ACCESS,
      [MANAGER]: {
        isOwner: false,
        permissions: ['functions.manage', 'functions.run', 'kick'],
      },
      [RUNNER]: { isOwner: false, permissions: ['functions.run', 'kick'] },
      [PLAIN]: { isOwner: false, permissions: [] },
    };
    const admins = Object.entries(shapes).map(([id, access]) =>
      sampleAdmin({ telegramId: Number(id), ...access }),
    );
    fake.adminStore.getAdmin.mockImplementation(async (id) =>
      admins.find((admin) => admin.telegramId === id),
    );
    fake.adminStore.listAdmins.mockResolvedValue(admins);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    as: number,
    payload?: object,
  ) {
    app ??= await createMiniAppServer(fake.deps, { botToken: TOKEN });
    return app.inject({
      method,
      url: `/api${url}`,
      headers: auth(as),
      ...(payload ? { payload } : {}),
    });
  }

  async function define(body: object = GIVE) {
    const response = await call('POST', '/functions', OWNER, body);
    expect(response.statusCode).toBe(200);
    return response.json<{ id: number }>();
  }

  describe('permission gates', () => {
    it.each([
      ['GET', '/functions', RUNNER],
      ['POST', '/functions', RUNNER],
      ['PUT', '/functions/1', RUNNER],
      ['DELETE', '/functions/1', RUNNER],
      ['POST', '/functions/preview', RUNNER],
      ['GET', '/servers/default/functions', PLAIN],
      ['POST', '/servers/default/functions/1/run', PLAIN],
    ] as const)('%s %s is forbidden to %i', async (method, url, as) => {
      const response = await call(method, url, as, {});
      expect(response.statusCode).toBe(403);
    });
  });

  describe('defining', () => {
    it('lets the owner create, list, update and delete one, and audits each', async () => {
      const { id } = await define();
      const list = await call('GET', '/functions', MANAGER);
      expect(list.json().functions).toHaveLength(1);

      const updated = await call('PUT', `/functions/${id}`, OWNER, {
        ...GIVE,
        title: 'Give a weapon',
        dangerous: true,
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ title: 'Give a weapon', dangerous: true });

      expect(
        (await call('DELETE', `/functions/${id}`, OWNER)).statusCode,
      ).toBe(200);
      expect((await call('GET', '/functions', OWNER)).json().functions).toEqual([]);

      expect(
        fake.adminStore.recordAuditLog.mock.calls.map(([entry]) => entry.action),
      ).toEqual(['functioncreate', 'functionupdate', 'functiondelete']);
    });

    it('lets someone the owner granted functions.manage define one', async () => {
      const response = await call('POST', '/functions', MANAGER, GIVE);
      expect(response.statusCode).toBe(200);
    });

    it('refuses a duplicate id, an id change, and a bad definition', async () => {
      const { id } = await define();
      expect((await call('POST', '/functions', OWNER, GIVE)).statusCode).toBe(409);
      expect(
        (await call('PUT', `/functions/${id}`, OWNER, { ...GIVE, slug: 'other' }))
          .statusCode,
      ).toBe(400);
      const bad = await call('POST', '/functions', OWNER, {
        ...SAY,
        slug: 'bad',
        definition: { params: [], steps: ['say hi; quit'] },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().message).toMatch(/one command/);
      expect((await call('PUT', '/functions/99', OWNER, GIVE)).statusCode).toBe(404);
    });

    it('previews a draft without sending anything', async () => {
      const response = await call('POST', '/functions/preview', OWNER, {
        function: SAY,
        values: { msg: 'hello' },
      });
      expect(response.json()).toEqual({ commands: ['say "hello"', 'say done'] });
      expect(fake.rcon.rcon).not.toHaveBeenCalled();

      const setting = await call('POST', '/functions/preview', OWNER, {
        function: {
          slug: 'grav',
          title: 'Gravity',
          kind: 'setting',
          definition: { cvar: 'g_gravity', control: { type: 'number', min: 100 } },
        },
        value: 800,
      });
      expect(setting.json()).toEqual({ commands: ['set g_gravity "800"'] });
    });
  });

  describe('running', () => {
    it('lists only what is enabled, on this server, and allowed to the caller', async () => {
      await define(GIVE);
      await define(SAY);
      await define({ ...SAY, slug: 'off', title: 'Off', enabled: false });
      await define({ ...SAY, slug: 'elsewhere', title: 'Elsewhere', serverAlias: 'other' });

      const runner = await call('GET', '/servers/default/functions', RUNNER);
      expect(runner.json().functions.map((fn: { slug: string }) => fn.slug).sort()).toEqual(
        ['give', 'shout'],
      );

      // functions.run without the kick the function requires: it isn't shown.
      fake.adminStore.getAdmin.mockResolvedValueOnce(
        sampleAdmin({ telegramId: 7, isOwner: false, permissions: ['functions.run'] }),
      );
      const limited = await call('GET', '/servers/default/functions', 7);
      expect(limited.json().functions.map((fn: { slug: string }) => fn.slug)).toEqual(['shout']);
    });

    it('resolves on the server, sends every step, and audits the commands', async () => {
      const { id } = await define(SAY);
      fake.rcon.rcon.mockResolvedValueOnce('ok1\n').mockResolvedValueOnce('ok2');
      const response = await call(
        'POST',
        `/servers/default/functions/${id}/run`,
        RUNNER,
        { values: { msg: 'hi; quit' } },
      );
      expect(response.statusCode).toBe(200);
      expect(fake.rcon.rcon.mock.calls.map(([c]) => c)).toEqual(['say "hi quit"', 'say done']);
      expect(response.json().steps).toEqual([
        { command: 'say "hi quit"', output: 'ok1' },
        { command: 'say done', output: 'ok2' },
      ]);
      const entry = fake.adminStore.recordAuditLog.mock.calls.at(-1)?.[0];
      expect(entry).toMatchObject({
        action: 'functionrun',
        target: 'shout',
        serverAlias: 'default',
        source: 'miniapp',
        detailJson: { commands: ['say "hi quit"', 'say done'], planned: 2 },
      });
    });

    it('checks the player is still in the slot, then uses the slot', async () => {
      const { id } = await define(GIVE);
      fake.rcon.status.mockResolvedValue({
        raw: '',
        players: [{ num: 3, name: 'Vika', score: 0, ping: 1 }],
      });
      const stale = await call('POST', `/servers/default/functions/${id}/run`, RUNNER, {
        values: { weapon: 'ak47', player: { num: 3, name: 'Someone' } },
      });
      expect(stale.statusCode).toBe(400);
      expect(fake.rcon.rcon).not.toHaveBeenCalled();

      const ok = await call('POST', `/servers/default/functions/${id}/run`, RUNNER, {
        values: { weapon: 'ak47', player: { num: 3, name: 'Vika' } },
      });
      expect(ok.json()).toMatchObject({ steps: expect.any(Array) });
      expect(fake.rcon.rcon).toHaveBeenCalledWith('scr_give 3 ak47');
    });

    it('answers 404 for a function hidden from the caller', async () => {
      const { id } = await define(GIVE);
      const disabled = await define({ ...SAY, slug: 'off', enabled: false });
      fake.adminStore.getAdmin.mockResolvedValueOnce(
        sampleAdmin({ telegramId: 7, isOwner: false, permissions: ['functions.run'] }),
      );
      expect(
        (await call('POST', `/servers/default/functions/${id}/run`, 7, {})).statusCode,
      ).toBe(404);
      expect(
        (await call('POST', `/servers/default/functions/${disabled.id}/run`, OWNER, {
          values: { msg: 'x' },
        })).statusCode,
      ).toBe(404);
      expect(
        (await call('POST', '/servers/other/functions/1/run', OWNER, {})).statusCode,
      ).toBe(404);
    });

    it('asks for a confirmation on a dangerous function', async () => {
      const { id } = await define({ ...SAY, dangerous: true });
      const url = `/servers/default/functions/${id}/run`;
      const refused = await call('POST', url, RUNNER, { values: { msg: 'x' } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toBe('confirm_required');
      expect(fake.rcon.rcon).not.toHaveBeenCalled();
      const ok = await call('POST', url, RUNNER, { values: { msg: 'x' }, confirm: true });
      expect(ok.statusCode).toBe(200);
    });

    it('sets a setting through the cvar path', async () => {
      const { id } = await define({
        slug: 'grav',
        title: 'Gravity',
        kind: 'setting',
        definition: { cvar: 'g_gravity', control: { type: 'number', min: 100, max: 1000 } },
      });
      const url = `/servers/default/functions/${id}/run`;
      expect((await call('POST', url, RUNNER, { value: 5000 })).statusCode).toBe(400);
      expect((await call('POST', url, RUNNER, { value: 700 })).statusCode).toBe(200);
      expect(fake.rcon.setCvar).toHaveBeenCalledWith('g_gravity', '700');
    });

    it('audits what reached the server when a later step fails', async () => {
      const { id } = await define(SAY);
      fake.rcon.rcon.mockResolvedValueOnce('').mockRejectedValueOnce(new Error('boom'));
      const response = await call('POST', `/servers/default/functions/${id}/run`, RUNNER, {
        values: { msg: 'hi' },
      });
      expect(response.statusCode).toBe(500);
      expect(fake.adminStore.recordAuditLog.mock.calls.at(-1)?.[0]).toMatchObject({
        action: 'functionrun',
        detailJson: { commands: ['say "hi"'], planned: 2 },
      });
    });
  });
});
