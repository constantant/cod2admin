import { UdpQueryTimeoutError, type ServerStatus } from '@cod2admin/rcon-client';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { ADDSERVER_USAGE, addServerCommand, parseAddServerArgs } from './addserver.js';

const OWNER = { telegramId: 1, role: 'owner' as const };
const LIVE_STATUS: ServerStatus = {
  raw: 'map: mp_toujane\n...',
  mapName: 'mp_toujane',
  players: [{ num: 0, score: 0, ping: 50, name: 'A' }],
};

function setup(status: ServerStatus | Error = LIVE_STATUS) {
  const fake = createFakeDeps();
  const newRcon = createFakeRcon();
  if (status instanceof Error) {
    newRcon.status.mockRejectedValue(status);
  } else {
    newRcon.status.mockResolvedValue(status);
  }
  fake.deps.createRconClient = vi.fn(() => asRconClient(newRcon));
  return { ...fake, newRcon };
}

function privateCtx(match: string) {
  return createFakeCtx({
    match,
    chat: { id: 100, type: 'private' },
    admin: OWNER,
    deleteMessage: vi.fn().mockResolvedValue(true),
  });
}

describe('parseAddServerArgs', () => {
  it('parses alias, host:port and password', () => {
    expect(parseAddServerArgs('ctf2 185.158.113.146:28996 s3cret')).toEqual({
      alias: 'ctf2',
      host: '185.158.113.146',
      port: 28996,
      password: 's3cret',
    });
  });

  it.each([
    ['', ADDSERVER_USAGE],
    ['ctf2 1.2.3.4:28960', ADDSERVER_USAGE],
    ['ctf2 1.2.3.4:28960 pw extra', ADDSERVER_USAGE],
    ['bad/alias 1.2.3.4:28960 pw', 'Alias "bad/alias" isn\'t valid'],
    ['ctf2 1.2.3.4 pw', '"1.2.3.4" isn\'t a valid address'],
    ['ctf2 1.2.3.4:70000 pw', '"1.2.3.4:70000" isn\'t a valid address'],
  ])('rejects %j', (text, expected) => {
    expect(parseAddServerArgs(text)).toEqual(expect.stringContaining(expected));
  });
});

describe('addServerCommand', () => {
  it('tests the server, saves it, makes it usable right away, and deletes the password message', async () => {
    const { deps, adminStore, newRcon } = setup();
    const ctx = privateCtx('ctf2 185.158.113.146:28996 s3cret');

    await addServerCommand(ctx, deps);

    expect(ctx.deleteMessage).toHaveBeenCalledOnce();
    expect(deps.createRconClient).toHaveBeenCalledWith({ host: '185.158.113.146', port: 28996, password: 's3cret' });
    expect(adminStore.upsertServer).toHaveBeenCalledWith({
      alias: 'ctf2',
      rconHost: '185.158.113.146',
      rconPort: 28996,
      rconPassword: 's3cret',
    });
    expect(deps.rconClients.get('ctf2')).toBe(asRconClient(newRcon));
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'addserver', target: 'ctf2', detailJson: { host: '185.158.113.146', port: 28996 } }),
    );
    expect(JSON.stringify(adminStore.recordAuditLog.mock.calls)).not.toContain('s3cret');
    expect(ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining('Server "ctf2" added: 185.158.113.146:28996 — mp_toujane, 1 player.'));
  });

  it('keeps commands without --server going to the config-file server when there was no default yet', async () => {
    const { deps, adminStore } = setup();
    const ctx = privateCtx('ctf2 1.2.3.4:28960 pw');

    await addServerCommand(ctx, deps);

    expect(adminStore.setDefaultServer).toHaveBeenCalledWith('default');
    expect(ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining('still go to "default"'));
  });

  it('leaves an existing default alone', async () => {
    const { deps, adminStore } = setup();
    adminStore.getDefaultServer.mockResolvedValue({
      alias: 'default',
      rconHost: 'h',
      rconPort: 1,
      rconPassword: 'p',
      logSourceConfig: null,
      boundTelegramChatId: null,
      isDefault: true,
    });

    await addServerCommand(privateCtx('ctf2 1.2.3.4:28960 pw'), deps);

    expect(adminStore.setDefaultServer).not.toHaveBeenCalled();
  });

  it('reports "updated" when the alias was already added before', async () => {
    const { deps, adminStore } = setup();
    deps.rconClients.set('ctf2', asRconClient(createFakeRcon()));
    const ctx = privateCtx('ctf2 1.2.3.4:28960 new-pw');

    await addServerCommand(ctx, deps);

    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'updateserver' }));
    expect(ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining('Server "ctf2" updated'));
  });

  it('saves nothing when the server rejects the password', async () => {
    const { deps, adminStore } = setup({ raw: 'Bad rconpassword.\n', players: [] });
    const ctx = privateCtx('ctf2 1.2.3.4:28960 wrong');

    await addServerCommand(ctx, deps);

    expect(adminStore.upsertServer).not.toHaveBeenCalled();
    expect(deps.rconClients.has('ctf2')).toBe(false);
    expect(ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining('rejected the RCON password'));
  });

  it('saves nothing when the server never answers', async () => {
    const { deps, adminStore } = setup(new UdpQueryTimeoutError('timed out'));
    const ctx = privateCtx('ctf2 1.2.3.4:28960 pw');

    await addServerCommand(ctx, deps);

    expect(adminStore.upsertServer).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining('No answer from 1.2.3.4:28960'));
  });

  it('refuses to overwrite the config-file server', async () => {
    const { deps, adminStore } = setup();
    const ctx = privateCtx('default 1.2.3.4:28960 pw');

    await addServerCommand(ctx, deps);

    expect(deps.createRconClient).not.toHaveBeenCalled();
    expect(adminStore.upsertServer).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining('comes from the bot\'s config file'));
  });

  it('refuses in a group, deletes the message there, and warns about the exposed password', async () => {
    const { deps, adminStore } = setup();
    const ctx = createFakeCtx({
      match: 'ctf2 1.2.3.4:28960 pw',
      chat: { id: -100, type: 'supergroup' },
      admin: OWNER,
      deleteMessage: vi.fn().mockResolvedValue(true),
    });

    await addServerCommand(ctx, deps);

    expect(ctx.deleteMessage).toHaveBeenCalledOnce();
    expect(adminStore.upsertServer).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('only works in a private chat'));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('I deleted your message here'));
  });

  it('asks the user to delete the message themselves when the bot cannot delete it in a group', async () => {
    const { deps } = setup();
    const ctx = createFakeCtx({
      match: 'ctf2 1.2.3.4:28960 pw',
      chat: { id: -100, type: 'group' },
      admin: OWNER,
      deleteMessage: vi.fn().mockRejectedValue(new Error('not enough rights')),
    });

    await addServerCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('please delete it yourself'));
  });
});
