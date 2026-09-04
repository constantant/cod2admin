/**
 * Quake3/CoD out-of-band (OOB) UDP packet framing — see docs/PLAN.md §2.4/§3.1.
 * Every OOB packet (queries, rcon commands, and their responses) is prefixed with
 * four 0xFF bytes followed by an ASCII payload.
 */
const OOB_PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export function buildOobPacket(payload: string): Buffer {
  return Buffer.concat([OOB_PREFIX, Buffer.from(payload, 'binary')]);
}

export interface OobPacket {
  /** First line of the payload, e.g. "infoResponse" / "statusResponse" / "print". */
  header: string;
  /** Everything after the header's newline. */
  body: string;
}

export function parseOobPacket(data: Buffer): OobPacket {
  if (data.length < 4 || !data.subarray(0, 4).equals(OOB_PREFIX)) {
    throw new Error('Not an out-of-band CoD/Quake3 packet (missing 0xFFFFFFFF prefix)');
  }
  const text = data.subarray(4).toString('binary');
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex === -1) {
    return { header: text, body: '' };
  }
  return {
    header: text.slice(0, newlineIndex),
    body: text.slice(newlineIndex + 1),
  };
}
