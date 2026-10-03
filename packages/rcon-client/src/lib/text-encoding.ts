/**
 * Single-byte text encodings a CoD2 server's strings (player names, chat, `say` text, log lines)
 * can be in. The game itself has no notion of encoding — it shows bytes using the player's
 * Windows code page, so Russian servers effectively run on CP1251 (docs/PLAN.md §2.4,
 * "Text encoding"). `latin1` maps each byte to the code point of the same value, which round-trips
 * any bytes but only displays Western European text correctly.
 */
export type TextEncoding = 'cp1251' | 'latin1';

export const TEXT_ENCODINGS: readonly TextEncoding[] = ['cp1251', 'latin1'];

/**
 * Windows-1251 bytes 0x80–0xFF as code points. 0x98 is unassigned in CP1251 and is mapped to
 * U+0098 (as the WHATWG Encoding Standard does), so all 256 bytes map to distinct code points and
 * decode → encode always gives back the same bytes. That's what lets a name read from `rcon status`
 * be passed back to `kick` unchanged.
 */
// prettier-ignore
const CP1251_HIGH_HALF = [
  0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039, 0x040a, 0x040c, 0x040b, 0x040f,
  0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122, 0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f,
  0x00a0, 0x040e, 0x045e, 0x0408, 0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407,
  0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455, 0x0457,
  // 0xC0–0xFF: А–я, contiguous.
  ...Array.from({ length: 64 }, (_, i) => 0x0410 + i),
];

const CP1251_ENCODE = new Map(CP1251_HIGH_HALF.map((codePoint, i) => [codePoint, 0x80 + i]));

const UNMAPPABLE_BYTE = 0x3f; // '?'

export function decodeText(bytes: Buffer, encoding: TextEncoding): string {
  if (encoding === 'latin1') {
    return bytes.toString('latin1');
  }
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte < 0x80 ? byte : CP1251_HIGH_HALF[byte - 0x80]);
  }
  return text;
}

/** Characters the encoding can't represent (emoji, CJK, ...) become `?`. */
export function encodeText(text: string, encoding: TextEncoding): Buffer {
  const bytes: number[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? UNMAPPABLE_BYTE;
    if (encoding === 'latin1') {
      bytes.push(codePoint <= 0xff ? codePoint : UNMAPPABLE_BYTE);
    } else {
      bytes.push(codePoint < 0x80 ? codePoint : (CP1251_ENCODE.get(codePoint) ?? UNMAPPABLE_BYTE));
    }
  }
  return Buffer.from(bytes);
}
