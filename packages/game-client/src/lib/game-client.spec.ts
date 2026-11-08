import { readFileSync } from 'node:fs';
import { createSocket, type Socket } from 'node:dgram';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOobPacket } from '@cod2admin/rcon-client';
import { BitMsg } from './bit-msg.js';
import { SVC_SNAPSHOT } from './constants.js';
import { HUFF_FREQ } from './huff-data.js';
import { huffmanCompress, huffmanDecompress } from './huffman.js';
import { ConnectRefusedError, GamePeer } from './peer.js';
import { parseServerMessage } from './snapshot.js';
import {
  buildDisconnectDatagram,
  buildGetchallengePacket,
  buildSpectatorUserinfo,
  connectAllowed,
  decodeClientDatagram,
  parseStatusBody,
} from './wire.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8').trim();
}

describe('OOB challenge framing', () => {
  it('uses the same 0xFFFFFFFF prefix as rcon-client', () => {
    const packet = buildGetchallengePacket();
    expect(packet.subarray(0, 4)).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff]));
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
    expect(huffmanDecompress(compressed.data, 8)).toEqual({ ok: false, reason: 'cap' });
    expect(() => huffmanDecompress(compressed.data, 8)).not.toThrow();
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
    expect(result).toEqual({ ok: false, reason: 'truncated', serverCommands: [] });
  });
});

describe('getstatus gate', () => {
  it('takes the protocol from the fixture', () => {
    const protocol118 = parseStatusBody(fixture('getstatus-118.txt'));
    const protocol115 = parseStatusBody(fixture('getstatus-115.txt'));
    expect(connectAllowed(protocol118)).toEqual({ ok: true, protocol: 118 });
    expect(connectAllowed(protocol115)).toEqual({ ok: true, protocol: 115 });
    expect(buildSpectatorUserinfo({ protocol: protocol118.protocol ?? 0, challenge: 1, qport: 2 })).toContain(
      '\\protocol\\118\\',
    );
    expect(buildSpectatorUserinfo({ protocol: protocol115.protocol ?? 0, challenge: 1, qport: 2 })).toContain(
      '\\protocol\\115\\',
    );
    expect(buildSpectatorUserinfo({ protocol: protocol115.protocol ?? 0, challenge: 1, qport: 2 })).not.toContain(
      'checksum',
    );
  });

  it('refuses a missing or non-zero pure or punkbuster key', () => {
    expect(connectAllowed(parseStatusBody(fixture('getstatus-pure-missing.txt'))).ok).toBe(false);
    expect(connectAllowed(parseStatusBody(fixture('getstatus-pb-1.txt'))).ok).toBe(false);
    expect(connectAllowed(parseStatusBody('\\protocol\\118\\sv_pure\\1\\sv_punkbuster\\0')).ok).toBe(false);
    expect(connectAllowed(parseStatusBody('\\protocol\\118\\sv_pure\\0')).ok).toBe(false);
    expect(connectAllowed(parseStatusBody('\\sv_pure\\0\\sv_punkbuster\\0')).ok).toBe(false);
  });

  it('does not send connect when getstatus pure is not 0', async () => {
    const socket = await listen();
    const seen: string[] = [];
    socket.on('message', (msg, rinfo) => {
      const text = msg.subarray(4).toString('latin1').replace(/\0/g, '');
      seen.push(text);
      if (text.startsWith('getstatus')) {
        const body = `statusResponse\n${fixture('getstatus-pure-missing.txt').replace('sv_punkbuster\\0', 'sv_pure\\1\\sv_punkbuster\\0')}\n`;
        socket.send(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from(body)]), rinfo.port, rinfo.address);
      }
    });
    const address = socket.address();
    await expect(
      GamePeer.connect({ host: '127.0.0.1', port: address.port, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(ConnectRefusedError);
    expect(seen.some((line) => line.startsWith('connect'))).toBe(false);
    socket.close();
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
    expect(packet.subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(false);
    expect(packet.readInt32LE(0)).toBe(1);
    expect(packet.readUInt16LE(4)).toBe(0x1234);
    expect(decodeClientDatagram(packet, 0x11, '')).toMatchObject({
      commands: ['disconnect'],
      move: false,
      serverId: 0,
    });
    expect(packet.toString('hex')).toBe('010000003412000000000000000000ba7de4035bcff2481717c9f2bd');
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
