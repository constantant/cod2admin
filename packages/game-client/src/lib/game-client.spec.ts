import { readFileSync } from 'node:fs';
import { createSocket, type Socket } from 'node:dgram';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOobPacket, parseOobPacket } from '@cod2admin/rcon-client';
import { BitMsg } from './bit-msg.js';
import {
  CLC_MOVE_NO_DELTA,
  CLIENT_CLEAR_HEADER,
  SVC_EOF,
  SVC_GAMESTATE,
  SVC_SNAPSHOT,
} from './constants.js';
import { HUFF_FREQ } from './huff-data.js';
import { huffmanCompress, huffmanDecompress } from './huffman.js';
import { GamePeer, samplesFromSnapshot } from './peer.js';
import type { EntityObservation } from './snapshot.js';
import { parseServerMessage } from './snapshot.js';
import {
  acknowledgeReliableCommands,
  buildClientDatagram,
  buildDisconnectDatagram,
  buildGetchallengePacket,
  buildSpectatorUserinfo,
  collectReliableCommands,
  comHashKey,
  connectAllowed,
  decodeClientDatagram,
  pureClientCommand,
  type ReliableCommandState,
  FragmentAssembler,
  parseStatusBody,
  sanitizeSpectatorName,
  SPECTATOR_NAME,
} from './wire.js';

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures',
);

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8').trim();
}

function fixtureBytes(name: string): Buffer {
  return readFileSync(join(fixtures, name));
}

describe('OOB challenge framing', () => {
  it('uses the same 0xFFFFFFFF prefix as rcon-client', () => {
    const packet = buildGetchallengePacket();
    expect(packet.subarray(0, 4)).toEqual(
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
    );
    expect(packet).toEqual(buildOobPacket('getchallenge'));
    expect(packet.subarray(4).toString('latin1')).toBe('getchallenge');
  });
});

describe('Huffman', () => {
  it('has the 256-symbol weight table and round-trips', () => {
    expect(HUFF_FREQ).toHaveLength(256);
    const input = Uint8Array.from({ length: 64 }, (_, i) => i * 3);
    const compressed = huffmanCompress(input, 256);
    expect(compressed.ok).toBe(true);
    if (!compressed.ok) return;
    const plain = huffmanDecompress(compressed.data, 256);
    expect(plain).toEqual({ ok: true, data: input });
  });

  it('fails when output would pass the cap and does not throw', () => {
    const input = new Uint8Array(200);
    const compressed = huffmanCompress(input, 64);
    expect(compressed.ok).toBe(true);
    if (!compressed.ok) return;
    expect(huffmanDecompress(compressed.data, 8)).toEqual({
      ok: false,
      reason: 'cap',
    });
    expect(() => huffmanDecompress(compressed.data, 8)).not.toThrow();
  });

  it('fails when a code is cut mid-symbol', () => {
    const input = Uint8Array.from(
      { length: 40 },
      (_, i) => (i * 17 + 3) & 0xff,
    );
    const compressed = huffmanCompress(input, 256);
    expect(compressed.ok).toBe(true);
    if (!compressed.ok) return;
    const full = compressed.data;
    let truncated = false;
    for (let bytes = full.length; bytes >= 1 && !truncated; bytes--) {
      for (let keep = 8; keep >= 1; keep--) {
        const cut = full.slice(0, bytes);
        if (keep < 8) {
          const mask = (1 << keep) - 1;
          const last = cut[cut.length - 1] ?? 0;
          // Dropping only zero pad is the compressor's byte align, not a cut symbol.
          if ((last & ~mask) === 0) continue;
          cut[cut.length - 1] = last & mask;
        } else if (bytes === full.length) {
          continue;
        }
        const result = huffmanDecompress(cut, 256);
        if (!result.ok && result.reason === 'truncated') truncated = true;
      }
    }
    expect(truncated).toBe(true);
  });
});

describe('snapshot parser', () => {
  it('fails a truncated snapshot instead of throwing', () => {
    const msg = BitMsg.alloc(64);
    msg.writeLong(0);
    msg.writeByte(SVC_SNAPSHOT);
    msg.writeLong(1000);
    let result: ReturnType<typeof parseServerMessage> | undefined;
    expect(() => {
      result = parseServerMessage(msg.bytes(), 118);
    }).not.toThrow();
    expect(result).toEqual({
      ok: false,
      reason: 'truncated',
      serverCommands: [],
    });
  });
});

describe('getstatus gate', () => {
  it('takes the protocol from the fixture', () => {
    const protocol118 = parseStatusBody(fixture('getstatus-118.txt'));
    const protocol115 = parseStatusBody(fixture('getstatus-115.txt'));
    expect(connectAllowed(protocol118)).toEqual({ ok: true, protocol: 118 });
    expect(connectAllowed(protocol115)).toEqual({ ok: true, protocol: 115 });
    expect(pureClientCommand(0)).toBe('cp @ 0');
    expect(pureClientCommand(-41)).toBe('cp @ -41');
    expect(
      buildSpectatorUserinfo({
        protocol: protocol118.protocol ?? 0,
        challenge: 1,
        qport: 2,
      }),
    ).toContain('\\protocol\\118\\');
    expect(
      buildSpectatorUserinfo({
        protocol: protocol115.protocol ?? 0,
        challenge: 1,
        qport: 2,
      }),
    ).toContain('\\protocol\\115\\');
    expect(
      buildSpectatorUserinfo({
        protocol: protocol115.protocol ?? 0,
        challenge: 1,
        qport: 2,
      }),
    ).not.toContain('checksum');
    const userinfo = buildSpectatorUserinfo({
      protocol: 118,
      challenge: 1,
      qport: 2,
    });
    expect(userinfo).toContain(`\\name\\${SPECTATOR_NAME}\\`);
    expect(sanitizeSpectatorName('a\\b"c;d')).toBe('abcd');
    expect(sanitizeSpectatorName('\\";')).toBe(SPECTATOR_NAME);
    expect(userinfo.split('\\name\\')[1]?.split('\\')[0]).toBe(SPECTATOR_NAME);
  });

  it('reads a captured getstatus datagram and a fragmented snapshot', () => {
    const status = parseOobPacket(fixtureBytes('pure-still-1-0.bin'));
    expect(status.header).toBe('statusResponse');
    const info = parseStatusBody(status.body);
    expect(info.protocol).toBe(118);
    expect(info.sv_pure).toBe('1');
    expect(info.sv_punkbuster).toBe('0');
    const fragment = new FragmentAssembler(info.protocol ?? 0).push(
      fixtureBytes('pure-0-3.bin'),
    );
    expect(fragment).toMatchObject({ ok: true, pending: true, sequence: 1 });
  });

  it('allows sv_pure 1 and refuses a missing or non-zero punkbuster key', () => {
    expect(
      connectAllowed(parseStatusBody(fixture('getstatus-pure-missing.txt'))),
    ).toEqual({ ok: true, protocol: 118 });
    expect(
      connectAllowed(parseStatusBody(fixture('getstatus-pb-1.txt'))).ok,
    ).toBe(false);
    expect(
      connectAllowed(
        parseStatusBody('\\protocol\\118\\sv_pure\\1\\sv_punkbuster\\0'),
      ),
    ).toEqual({ ok: true, protocol: 118 });
    expect(
      connectAllowed(parseStatusBody('\\protocol\\118\\sv_pure\\0')).ok,
    ).toBe(false);
    expect(
      connectAllowed(parseStatusBody('\\sv_pure\\0\\sv_punkbuster\\0')).ok,
    ).toBe(false);
  });

  it('keeps going when getstatus sv_pure is 1', async () => {
    const socket = await listen();
    const seen: string[] = [];
    socket.on('message', (msg, rinfo) => {
      const text = msg.subarray(4).toString('latin1').replace(/\0/g, '');
      seen.push(text);
      if (text.startsWith('getstatus')) {
        const body = `statusResponse\n${fixture('getstatus-pure-missing.txt').replace('sv_punkbuster\\0', 'sv_pure\\1\\sv_punkbuster\\0')}\n`;
        socket.send(
          Buffer.concat([
            Buffer.from([0xff, 0xff, 0xff, 0xff]),
            Buffer.from(body),
          ]),
          rinfo.port,
          rinfo.address,
        );
      }
    });
    const address = socket.address();
    await expect(
      GamePeer.connect({
        host: '127.0.0.1',
        port: address.port,
        timeoutMs: 300,
      }),
    ).rejects.toThrow('timed out waiting for server');
    expect(seen.some((line) => line.startsWith('getchallenge'))).toBe(true);
    socket.close();
  });
});

describe('jump keepalive', () => {
  it('holds jump only, for a short time and a wide time, and for a negative key', () => {
    const cases = [
      { checksumFeed: 0, messageAcknowledge: 0, serverTime: 100, command: '' },
      { checksumFeed: 1, messageAcknowledge: 0, serverTime: 100, command: '' },
      {
        checksumFeed: 0,
        messageAcknowledge: 0x80000000,
        serverTime: 100_000,
        command: '',
      },
    ];
    for (const sample of cases) {
      const key =
        (sample.checksumFeed ^
          sample.messageAcknowledge ^
          comHashKey(sample.command, 32)) |
        0;
      const packet = buildClientDatagram({
        sequence: 1,
        qport: 1,
        challenge: 0,
        serverId: 0,
        messageAcknowledge: sample.messageAcknowledge,
        reliableAcknowledge: 0,
        ackedServerCommand: sample.command,
        checksumFeed: sample.checksumFeed,
        serverTime: sample.serverTime,
        commands: [],
        move: true,
      });
      const payload = packet.subarray(6);
      const compressed = Uint8Array.from(payload.subarray(CLIENT_CLEAR_HEADER));
      const plain = huffmanDecompress(compressed, 2048);
      expect(plain.ok).toBe(true);
      if (!plain.ok) return;
      const msg = new BitMsg(plain.data);
      expect(msg.readBits(3)).toBe(CLC_MOVE_NO_DELTA);
      expect(msg.readByte()).toBe(1);
      const serverTime = msg.readBit() === 1 ? msg.readByte() : msg.readLong();
      expect(serverTime).toBe(sample.serverTime);
      // MSG_ReadDeltaUsercmdKey long form against a zero command.
      expect(readKey(msg, key, 1)).toBe(1);
      expect(readKey(msg, key, 1)).toBe(1);
      expect(readKey(msg, key, 1)).toBe(0);
      expect(msg.readBit()).toBe(0);
      expect(msg.readBit()).toBe(0);
      expect(msg.readBit()).toBe(0);
      const keyed = (key ^ serverTime) | 0;
      expect(msg.readBit()).toBe(0);
      expect(readDeltaKey(msg, keyed, 0, 18)).toBe(512);
      expect(msg.readBit()).toBe(0);
      expect(msg.readBit()).toBe(0);
      const shift = msg.bit & 7;
      const partial = shift === 0 ? 0 : (msg.data[msg.bit >> 3] ?? 0) >> shift;
      expect(partial).toBe(0);
      expect(msg.readcount).toBe(msg.cursize);
      expect(msg.overflowed).toBe(false);
    }
  });
});

/** `MSG_ReadKey`: bits on the wire, then XOR with the low bits of the key. */
function readKey(msg: BitMsg, key: number, bits: number): number {
  const mask = (1 << bits) - 1;
  return (msg.readBits(bits) ^ (key & mask)) & mask;
}

/** `MSG_ReadDeltaKey`: a 0 bit keeps `oldV`. */
function readDeltaKey(
  msg: BitMsg,
  key: number,
  oldValue: number,
  bits: number,
): number {
  if (msg.readBit() === 0) return oldValue;
  return readKey(msg, key, bits);
}

describe('reliable client commands', () => {
  function queue(): ReliableCommandState {
    return {
      commandSeq: 1,
      ack: 0,
      sent: new Map(),
      needPure: true,
      checksumFeed: 41,
      sentTeam: false,
    };
  }

  it('sends cp and team once, then repeats them until the server acks', () => {
    const state = queue();
    const first = collectReliableCommands(state);
    expect(first.map((command) => command.text)).toEqual([
      'cp @ 41',
      'team spectator',
    ]);
    expect(first.map((command) => command.seq)).toEqual([1, 2]);

    const repeated = collectReliableCommands(state);
    expect(repeated).toEqual(first);
    expect(state.commandSeq).toBe(3);

    acknowledgeReliableCommands(state, 2);
    expect(collectReliableCommands(state)).toEqual([]);
  });

  it('rewrites an unacked cp when the map changes, and does not skip a sequence', () => {
    const state = queue();
    collectReliableCommands(state);
    acknowledgeReliableCommands(state, 0);
    state.needPure = true;
    state.checksumFeed = 99;
    const next = collectReliableCommands(state);
    expect(next).toEqual([
      { seq: 1, text: 'cp @ 99' },
      { seq: 2, text: 'team spectator' },
    ]);
    expect(state.commandSeq).toBe(3);
  });

  it('does not treat a carried checksum feed as a new gamestate', () => {
    const msg = BitMsg.alloc(32);
    msg.writeLong(0);
    msg.writeByte(SVC_GAMESTATE);
    msg.writeLong(1);
    msg.writeByte(SVC_EOF);
    msg.writeLong(0);
    msg.writeLong(41);
    msg.writeByte(SVC_EOF);
    const gamestate = parseServerMessage(msg.bytes(), 118);
    expect(gamestate.ok).toBe(true);
    if (!gamestate.ok) return;
    expect(gamestate.message.gamestate).toBe(true);
    expect(gamestate.message.checksumFeed).toBe(41);

    const later = BitMsg.alloc(4);
    later.writeLong(2);
    const snapshot = parseServerMessage(later.bytes(), 118, gamestate.state);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.message.gamestate).toBe(false);
    expect(snapshot.message.checksumFeed).toBe(41);
    expect(snapshot.message.lastClientCommand).toBe(2);
  });
});

describe('disconnect packet', () => {
  it('is a sequenced reliable command, not an OOB disconnect', () => {
    const packet = buildDisconnectDatagram({
      sequence: 1,
      qport: 0x1234,
      challenge: 0x11,
      serverId: 0,
      messageAcknowledge: 0,
      reliableAcknowledge: 0,
      ackedServerCommand: '',
      checksumFeed: 0,
      serverTime: 0,
      commandSeq: 1,
    });
    expect(
      packet.subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0xff])),
    ).toBe(false);
    expect(packet.readInt32LE(0)).toBe(1);
    expect(packet.readUInt16LE(4)).toBe(0x1234);
    expect(decodeClientDatagram(packet, 0x11, '')).toMatchObject({
      commands: ['disconnect'],
      move: false,
      serverId: 0,
    });
    expect(packet.toString('hex')).toBe(
      '010000003412000000000000000000ba7de4035bcff2481717c9f2bd',
    );
  });

  it('delivers the disconnect command before it closes the socket', async () => {
    const socket = await listen();
    const copies: Buffer[] = [];
    socket.on('message', (msg, rinfo) => {
      const oob =
        msg.length >= 4 &&
        msg[0] === 0xff &&
        msg[1] === 0xff &&
        msg[2] === 0xff &&
        msg[3] === 0xff;
      if (!oob) {
        copies.push(Buffer.from(msg));
        return;
      }
      const text = msg.subarray(4).toString('latin1').replace(/\0/g, '');
      if (text.startsWith('getstatus')) {
        reply(
          socket,
          rinfo,
          `statusResponse\n${fixture('getstatus-pure-missing.txt')}`,
        );
        return;
      }
      if (text.startsWith('getchallenge')) {
        reply(socket, rinfo, 'challengeResponse 17');
        return;
      }
      if (text.startsWith('connect')) {
        reply(socket, rinfo, 'connectResponse');
        return;
      }
      copies.push(Buffer.from(msg));
    });
    const address = socket.address();
    const peer = await GamePeer.connect({
      host: '127.0.0.1',
      port: address.port,
      timeoutMs: 500,
    });
    try {
      await peer.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(copies).toHaveLength(3);
      expect(copies.every((copy) => copy.equals(copies[0]!))).toBe(true);
      expect(decodeClientDatagram(copies[0]!, 17, '')?.commands).toEqual([
        'disconnect',
      ]);
      expect(
        copies[0]!.subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0xff])),
      ).toBe(false);
      await peer.disconnect();
      expect(copies).toHaveLength(3);
    } finally {
      socket.close();
    }
  });
});

describe('samplesFromSnapshot', () => {
  it('files every visible player under the subject slot and copies trDelta', () => {
    const subject = observation(4, 10, [400, 0, 0]);
    const other = observation(2, 10, [0, 0, 0]);
    const samples = samplesFromSnapshot([subject, other], 10, 'ctf');
    expect(samples.every((sample) => sample.event === undefined)).toBe(true);
    expect(
      samples
        .filter((sample) => sample.slot === 4)
        .map((sample) => sample.entityNum)
        .sort(),
    ).toEqual([2, 4]);
    expect(
      samples.find((sample) => sample.slot === 4 && sample.entityNum === 4)
        ?.velocity,
    ).toEqual({ x: 400, y: 0, z: 0 });
    expect(samples.filter((sample) => sample.slot === 2)).toHaveLength(2);
  });
});

function observation(
  slot: number,
  serverTimeMs: number,
  velocity: readonly [number, number, number],
): EntityObservation {
  return {
    serverTimeMs,
    entityNum: slot,
    eType: 1,
    clientNum: slot,
    origin: [1, 2, 3],
    velocity,
    viewangles: [0, 90, 0],
    weapon: 0,
  };
}

function reply(
  socket: Socket,
  rinfo: { port: number; address: string },
  text: string,
): void {
  socket.send(
    Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from(text)]),
    rinfo.port,
    rinfo.address,
  );
}

function listen(): Promise<Socket> {
  const socket = createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}
