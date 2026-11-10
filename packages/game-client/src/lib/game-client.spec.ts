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
  SVC_SNAPSHOT,
} from './constants.js';
import { HUFF_FREQ } from './huff-data.js';
import { huffmanCompress, huffmanDecompress } from './huffman.js';
import { ConnectRefusedError, GamePeer } from './peer.js';
import { parseServerMessage } from './snapshot.js';
import {
  buildClientDatagram,
  buildDisconnectDatagram,
  buildGetchallengePacket,
  buildSpectatorUserinfo,
  comHashKey,
  connectAllowed,
  decodeClientDatagram,
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

  it('refuses a missing or non-zero pure or punkbuster key', () => {
    expect(
      connectAllowed(parseStatusBody(fixture('getstatus-pure-missing.txt'))).ok,
    ).toBe(false);
    expect(
      connectAllowed(parseStatusBody(fixture('getstatus-pb-1.txt'))).ok,
    ).toBe(false);
    expect(
      connectAllowed(
        parseStatusBody('\\protocol\\118\\sv_pure\\1\\sv_punkbuster\\0'),
      ).ok,
    ).toBe(false);
    expect(
      connectAllowed(parseStatusBody('\\protocol\\118\\sv_pure\\0')).ok,
    ).toBe(false);
    expect(
      connectAllowed(parseStatusBody('\\sv_pure\\0\\sv_punkbuster\\0')).ok,
    ).toBe(false);
  });

  it('does not send connect when getstatus pure is not 0', async () => {
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
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(ConnectRefusedError);
    expect(seen.some((line) => line.startsWith('connect'))).toBe(false);
    socket.close();
  });
});

describe('zero-button keepalive', () => {
  it('is a no-change usercmd for both even and odd keys', () => {
    for (const checksumFeed of [0, 1]) {
      const command = '';
      const messageAcknowledge = 0;
      const key =
        (checksumFeed ^ messageAcknowledge ^ comHashKey(command, 32)) | 0;
      const packet = buildClientDatagram({
        sequence: 1,
        qport: 1,
        challenge: 0,
        serverId: 0,
        messageAcknowledge,
        reliableAcknowledge: 0,
        ackedServerCommand: command,
        checksumFeed,
        serverTime: 100,
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
      expect(msg.readBit()).toBe(1);
      expect(msg.readByte()).toBe(100);
      const wire = msg.readBit();
      // MSG_ReadKey is the wire bit XOR (key & 1). Value 0 stops before buttons.
      expect(wire ^ (key & 1)).toBe(0);
      expect(wire).toBe(key & 1);
      const shift = msg.bit & 7;
      const partial = shift === 0 ? 0 : (msg.data[msg.bit >> 3] ?? 0) >> shift;
      expect(partial).toBe(0);
      expect(msg.readcount).toBe(msg.cursize);
      expect(msg.overflowed).toBe(false);
    }
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
});

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
