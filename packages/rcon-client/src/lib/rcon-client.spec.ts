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
    ['say', (client: RconClient) => client.say('hello'), 'rcon secret say "hello"'],
    ['say (quotes stripped)', (client: RconClient) => client.say('a "b" c'), 'rcon secret say "a b c"'],
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

  it('fetches and parses sv_mapRotation into a map name list', async () => {
    peer = await createMockPeer((payload, respond) => {
      if (payload === 'rcon secret sv_mapRotation') {
        respond('print\n"sv_mapRotation" is: "gametype tdm map mp_brecourt gametype ctf map mp_carentan^7" default: "^7"');
      }
    });
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'secret' });

    await expect(client.getMapRotation()).resolves.toEqual(['mp_brecourt', 'mp_carentan']);
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

  it('joins a print response split across several packets, including a split mid-line', async () => {
    // Real server, ~40 players: `rcon status` came back as 3 packets (1303+1303+115 bytes), each
    // with its own "print" header, the body split wherever the packet filled up.
    const table = [
      'map: mp_toujane',
      'num score ping guid   name            lastmsg address               qport rate',
      '--- ----- ---- ------ --------------- ------- --------------------- ----- -----',
      '  0     5   42 111111 PlayerOne^7           0 123.45.67.89:12345    54321 25000',
      '  1     3   50 222222 PlayerTwo^7           0 123.45.67.90:12345    54322 25000',
      '  2     1   60 333333 PlayerThree^7         0 123.45.67.91:12345    54323 25000',
      '',
    ].join('\n');
    const splitAt = [table.indexOf('PlayerTwo') + 4, table.indexOf('PlayerThree')];
    peer = await createMockPeer((payload, respond) => {
      if (payload === 'rcon secret status') {
        respond(`print\n${table.slice(0, splitAt[0])}`);
        respond(`print\n${table.slice(splitAt[0], splitAt[1])}`);
        respond(`print\n${table.slice(splitAt[1])}`);
      }
    });
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'secret' });

    const status = await client.status();

    expect(status.raw).toBe(table);
    expect(status.players.map((player) => player.name)).toEqual(['PlayerOne', 'PlayerTwo', 'PlayerThree']);
  });

  it('keeps retrying through a burst of dropped queries and succeeds once one gets through', async () => {
    // Mirrors the real rate-limited server: several queries in a row silently dropped, then a reply.
    let received = 0;
    peer = await createMockPeer((_payload, respond) => {
      received++;
      if (received >= 4) {
        respond('print\nOK\n');
      }
    });
    const client = new RconClient({
      host: '127.0.0.1',
      port: peer.port,
      password: 'secret',
      timeoutMs: 30,
      retryDelayMs: 5,
    });

    await expect(client.rcon('say hi')).resolves.toBe('OK\n');
    expect(received).toBe(4);
  });

  it('sends exactly retries + 1 attempts before giving up', async () => {
    let received = 0;
    peer = await createMockPeer(() => {
      received++;
    });
    const client = new RconClient({
      host: '127.0.0.1',
      port: peer.port,
      password: 'secret',
      timeoutMs: 20,
      retries: 3,
      retryDelayMs: 0,
    });

    await expect(client.rcon('status')).rejects.toThrow(/timed out/i);
    expect(received).toBe(4);
  });

  it('sends and receives cp1251 text when configured, so Russian say text and names survive', async () => {
    let receivedBytes: Buffer | undefined;
    const socket = dgram.createSocket('udp4');
    socket.on('message', (data, rinfo) => {
      receivedBytes = data.subarray(4);
      // "print\n" + "Димон" in Windows-1251
      const reply = Buffer.concat([
        OOB_PREFIX,
        Buffer.from('print\n', 'latin1'),
        Buffer.from([0xc4, 0xe8, 0xec, 0xee, 0xed]),
      ]);
      socket.send(reply, rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', () => resolve()));
    peer = { port: socket.address().port, close: () => new Promise((resolve) => socket.close(() => resolve())) };
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'pw', encoding: 'cp1251' });

    await expect(client.say('всем привет')).resolves.toBe('Димон');
    expect(receivedBytes).toEqual(
      Buffer.concat([
        Buffer.from('rcon pw say "', 'latin1'),
        Buffer.from('e2f1e5ec20eff0e8e2e5f2', 'hex'),
        Buffer.from('"', 'latin1'),
      ]),
    );
  });

  it('rejects with the unexpected-header message when the server replies with the wrong header', async () => {
    peer = await createMockPeer((_payload, respond) => {
      respond('print\nunexpected');
    });
    const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'pw' });

    await expect(client.getInfo()).rejects.toThrow(/unexpected response header/i);
  });

  describe('kick', () => {
    it('retries quoted when the unquoted attempt looks like a failure, and returns that result', async () => {
      const received: string[] = [];
      peer = await createMockPeer((payload, respond) => {
        received.push(payload);
        if (payload === 'rcon secret kick name') {
          respond('print\nUsage: kick <player name>\nkick all = kick everyone\n');
        } else if (payload === 'rcon secret kick "name"') {
          respond('print\n0:name EXE_PLAYERKICKED\n');
        }
      });
      const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'secret' });

      const result = await client.kick('name');

      expect(received).toEqual(['rcon secret kick name', 'rcon secret kick "name"']);
      expect(result).toBe('0:name EXE_PLAYERKICKED\n');
    });

    it('does not retry when the unquoted attempt succeeds', async () => {
      const received: string[] = [];
      peer = await createMockPeer((payload, respond) => {
        received.push(payload);
        respond('print\n0:name EXE_PLAYERKICKED\n');
      });
      const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'secret' });

      await client.kick('name');

      expect(received).toEqual(['rcon secret kick name']);
    });

    it('never retries for a numeric client id', async () => {
      const received: string[] = [];
      peer = await createMockPeer((payload, respond) => {
        received.push(payload);
        respond('print\nUsage: kick <player name>\nkick all = kick everyone\n');
      });
      const client = new RconClient({ host: '127.0.0.1', port: peer.port, password: 'secret' });

      await client.kick(3);

      expect(received).toEqual(['rcon secret kick 3']);
    });
  });
});
