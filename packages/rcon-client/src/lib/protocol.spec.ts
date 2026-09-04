import { describe, expect, it } from 'vitest';
import { buildOobPacket, parseOobPacket } from './protocol.js';

describe('buildOobPacket', () => {
  it('prefixes the payload with four 0xFF bytes', () => {
    const packet = buildOobPacket('getinfo');
    expect(packet.subarray(0, 4)).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(packet.subarray(4).toString('binary')).toBe('getinfo');
  });
});

describe('parseOobPacket', () => {
  it('splits header and body on the first newline', () => {
    const packet = buildOobPacket('print\nhello\nworld');
    expect(parseOobPacket(packet)).toEqual({ header: 'print', body: 'hello\nworld' });
  });

  it('returns an empty body when there is no newline', () => {
    const packet = buildOobPacket('infoResponse');
    expect(parseOobPacket(packet)).toEqual({ header: 'infoResponse', body: '' });
  });

  it('rejects packets missing the OOB prefix', () => {
    expect(() => parseOobPacket(Buffer.from('not-oob'))).toThrow(/0xFFFFFFFF/);
  });

  it('rejects packets shorter than the prefix', () => {
    expect(() => parseOobPacket(Buffer.from([0xff, 0xff]))).toThrow();
  });
});
