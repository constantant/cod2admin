import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { RconClient } from './rcon-client.js';

const OOB_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function oobPacket(payload: string): Buffer {
  return Buffer.concat([OOB_PREFIX, Buffer.from(payload, 'binary')]);
}

type MockHandler = (payload: string, respond: (payload: string) => void) => void;

interface MockPeer {
  port: number;
  close: () => Promise<void>;
}

/** A minimal in-process stand-in for a CoD2 dedicated server's OOB UDP responder. */
async function createMockPeer(handler: MockHandler): Promise<MockPeer> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (data, rinfo) => {
    if (data.length < 4 || !data.subarray(0, 4).equals(OOB_PREFIX)) {
      return;
    }
    const payload = data.subarray(4).toString('binary');
    handler(payload, (responsePayload) => {
      socket.send(oobPacket(responsePayload), rinfo.port, rinfo.address);
    });
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
  const address = socket.address();
  return {
    port: address.port,
    close: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}

describe('RconClient', () => {
  let peer: MockPeer | undefined;

  afterEach(async () => {
    await peer?.close();
    peer = undefined;
  });

  it('parses getinfo cvars', async () => {
    peer = await createMockPeer((payload, respond) => {
      if (payload === 'getinfo') {
        respond('infoResponse\n\\sv_hostname\\Test Server\\gametype\\dm');
      }
    });
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'pw' });

    await expect(client.getInfo()).resolves.toEqual({ sv_hostname: 'Test Server', gametype: 'dm' });
  });

  it('parses getstatus cvars and the minimal (no-IP) player list', async () => {
    peer = await createMockPeer((payload, respond) => {
      if (payload === 'getstatus') {
        respond('statusResponse\n\\sv_hostname\\Test Server\n5 42 "^1Player^7One"\n0 12 "PlayerTwo"');
      }
    });
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'pw' });

    const status = await client.getStatus();

    expect(status.cvars).toEqual({ sv_hostname: 'Test Server' });
    expect(status.players).toEqual([
      { score: 5, ping: 42, name: '^1Player^7One' },
      { score: 0, ping: 12, name: 'PlayerTwo' },
    ]);
  });

  it('sends rcon commands with the password and returns the print body', async () => {
    let received: string | undefined;
    peer = await createMockPeer((payload, respond) => {
      received = payload;
      respond('print\nKicked player 3\n');
    });
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'secret' });

    const result = await client.kick(3);

    expect(received).toBe('rcon secret kick 3');
    expect(result).toBe('Kicked player 3\n');
  });

  it.each([
    ['banClient', (client: RconClient) => client.banClient(2), 'rcon secret banClient 2'],
    ['banUser', (client: RconClient) => client.banUser(2), 'rcon secret banUser 2'],
    ['unbanUser', (client: RconClient) => client.unbanUser('GUID123'), 'rcon secret unbanUser GUID123'],
    ['say', (client: RconClient) => client.say('hello'), 'rcon secret say hello'],
    ['map', (client: RconClient) => client.map('mp_toujane'), 'rcon secret map mp_toujane'],
  ])('%s sends the expected raw rcon command', async (_name, action, expectedCommand) => {
    let received: string | undefined;
    peer = await createMockPeer((payload, respond) => {
      received = payload;
      respond('print\nOK\n');
    });
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'secret' });

    await action(client);

    expect(received).toBe(expectedCommand);
  });

  it('parses the rcon status player table including IPs', async () => {
    const table = [
      'map: mp_toujane',
      'num score ping name            lastmsg address               qport rate',
      '--- ----- ---- --------------- ------- --------------------- ----- -----',
      '0   5     42   Player One      0       123.45.67.89:12345    54321 25000',
      '',
    ].join('\n');
    peer = await createMockPeer((payload, respond) => {
      if (payload.startsWith('rcon secret status')) {
        respond(`print\n${table}`);
      }
    });
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'secret' });

    const status = await client.status();

    expect(status.mapName).toBe('mp_toujane');
    expect(status.players[0]).toMatchObject({ num: 0, ip: '123.45.67.89', port: 12345 });
  });

  it('retries and eventually rejects when the server never responds', async () => {
    peer = await createMockPeer(() => {
      // never responds — simulates a dropped UDP packet / unreachable host
    });
    const client = new RconClient({
      host: '127.0.0.1',
      port: peer.port,
      password: 'secret',
      timeoutMs: 30,
      retries: 1,
    });

    await expect(client.getInfo()).rejects.toThrow(/timed out/i);
  });

  it('rejects with the unexpected-header message when the server replies with the wrong header', async () => {
    peer = await createMockPeer((_payload, respond) => {
      respond('print\nunexpected');
    });
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'pw' });

    await expect(client.getInfo()).rejects.toThrow(/unexpected response header/i);
  });
});
