import { describe, expect, it } from 'vitest';
import { decodeText, encodeText } from './text-encoding.js';

const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

describe('cp1251', () => {
  it('encodes Russian text to Windows-1251 bytes', () => {
    expect([...encodeText('всем привет', 'cp1251')].map((b) => b.toString(16)).join(' ')).toBe(
      'e2 f1 e5 ec 20 ef f0 e8 e2 e5 f2',
    );
    expect(encodeText('Ёё №', 'cp1251')).toEqual(Buffer.from([0xa8, 0xb8, 0x20, 0xb9]));
  });

  it('decodes the bytes a real server sent for a Russian player name', () => {
    // Seen in `rcon status` on a real server, which showed as "Äèìîí" when decoded as latin1.
    expect(decodeText(Buffer.from('Äèìîí^7', 'latin1'), 'cp1251')).toBe('Димон^7');
  });

  it('matches the platform windows-1251 decoder for every assigned byte', () => {
    const reference = new TextDecoder('windows-1251').decode(ALL_BYTES);
    expect(decodeText(ALL_BYTES, 'cp1251')).toBe(reference);
  });

  it('round-trips all 256 byte values, so names can be passed back to kick unchanged', () => {
    expect(encodeText(decodeText(ALL_BYTES, 'cp1251'), 'cp1251')).toEqual(ALL_BYTES);
  });

  it('replaces characters it cannot represent with "?"', () => {
    expect(encodeText('hi 😀 中', 'cp1251').toString('latin1')).toBe('hi ? ?');
  });
});

describe('latin1', () => {
  it('round-trips all 256 byte values', () => {
    expect(encodeText(decodeText(ALL_BYTES, 'latin1'), 'latin1')).toEqual(ALL_BYTES);
  });

  it('replaces characters above U+00FF with "?" instead of truncating them', () => {
    // Buffer.from(text, 'binary') used to keep only the low byte: "в" (U+0432) became "2".
    expect(encodeText('вa', 'latin1').toString('latin1')).toBe('?a');
  });
});
