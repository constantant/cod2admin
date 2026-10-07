import { describe, expect, it } from 'vitest';
import {
  parseCvarBlock,
  parseGametypes,
  parseInstalledMaps,
  parseMapRotation,
  parseMapRotationEntries,
  parseOobPlayerLine,
  parseRconStatusTable,
  stripColorCodes,
} from './status-parser.js';

describe('parseMapRotationEntries', () => {
  it('pairs each map with the mode before it, keeping a map listed under two modes (CTF RUSSIA, 2026-10-07)', () => {
    const raw =
      '"sv_mapRotation" is: "gametype ctf map mp_breakout gametype ctf map mp_toujane gametype hq map mp_burgundy gametype hq map mp_toujane^7" default: "^7"\n  Domain is any text';

    expect(parseMapRotationEntries(raw)).toEqual([
      { map: 'mp_breakout', gametype: 'ctf' },
      { map: 'mp_toujane', gametype: 'ctf' },
      { map: 'mp_burgundy', gametype: 'hq' },
      { map: 'mp_toujane', gametype: 'hq' },
    ]);
  });

  it('keeps one entry per map and mode, and null when no mode was set yet', () => {
    const raw =
      '"sv_mapRotation" is: "map mp_harbor map mp_harbor gametype tdm map mp_rhine map mp_rhine^7"';

    expect(parseMapRotationEntries(raw)).toEqual([
      { map: 'mp_harbor', gametype: null },
      { map: 'mp_rhine', gametype: 'tdm' },
    ]);
  });

  it('returns no entries for an empty rotation', () => {
    expect(
      parseMapRotationEntries('"sv_mapRotation" is: "^7" default: "^7"'),
    ).toEqual([]);
  });
});

describe('parseGametypes', () => {
  it('lists the mode scripts and leaves out the shared _helpers (real reply, CTF RUSSIA 2026-10-07)', () => {
    const raw = [
      'Directory of maps/mp/gametypes gsc',
      '---------------',
      'tdm.gsc',
      '_callbacksetup.gsc',
      'sd.gsc',
      'hq.gsc',
      '_mapvote.gsc',
      'ctf.gsc',
      'dm.gsc',
      'ctf.gsc',
      '',
    ].join('\n');

    expect(parseGametypes(raw)).toEqual(['ctf', 'dm', 'hq', 'sd', 'tdm']);
  });

  it('returns nothing for an unexpected reply', () => {
    expect(parseGametypes('Unknown command "dir"')).toEqual([]);
  });
});

describe('stripColorCodes', () => {
  it('removes ^-digit color codes', () => {
    expect(stripColorCodes('^1Player^7One')).toBe('PlayerOne');
  });

  it('leaves plain names untouched', () => {
    expect(stripColorCodes('PlayerTwo')).toBe('PlayerTwo');
  });
});

describe('parseCvarBlock', () => {
  it('parses a leading-backslash key/value block', () => {
    expect(parseCvarBlock('\\sv_hostname\\Test Server\\gametype\\dm')).toEqual({
      sv_hostname: 'Test Server',
      gametype: 'dm',
    });
  });

  it('returns an empty object for an empty block', () => {
    expect(parseCvarBlock('')).toEqual({});
  });
});

describe('parseOobPlayerLine', () => {
  it('parses a quoted-name getstatus player line', () => {
    expect(parseOobPlayerLine('5 42 "PlayerOne"')).toEqual({
      score: 5,
      ping: 42,
      name: 'PlayerOne',
    });
  });

  it('returns null for lines that do not match the expected shape', () => {
    expect(parseOobPlayerLine('not a player line')).toBeNull();
    expect(parseOobPlayerLine('')).toBeNull();
  });
});

describe('parseInstalledMaps', () => {
  it('lists map files from a real `dir maps/mp d3dbsp` reply, sorted and de-duplicated', () => {
    // Shape captured from the dev server 2026-10-07, shortened, with CRLF and a duplicate.
    const raw = [
      'Directory of maps/mp d3dbsp',
      '---------------',
      'mp_toujane.d3dbsp',
      'mp_breakout.d3dbsp',
      'rts.d3dbsp',
      'mp_breakout.d3dbsp',
      '',
    ].join('\r\n');

    expect(parseInstalledMaps(raw)).toEqual([
      'mp_breakout',
      'mp_toujane',
      'rts',
    ]);
  });

  it('ignores headers, other file types and odd names', () => {
    expect(
      parseInstalledMaps(
        'Directory of maps/mp d3dbsp\n---------------\nmp_x.gsc\nbad name.d3dbsp\n',
      ),
    ).toEqual([]);
  });
});

describe('parseMapRotation', () => {
  it('extracts map names in order, de-duplicated, from a real sv_mapRotation response', () => {
    const raw =
      '"sv_mapRotation" is: "gametype tdm map mp_brecourt gametype ctf map mp_carentan gametype tdm map mp_brecourt^7" default: "^7"\n  Domain is any text';

    expect(parseMapRotation(raw)).toEqual(['mp_brecourt', 'mp_carentan']);
  });

  it('returns an empty array when the dvar value has no map entries', () => {
    expect(parseMapRotation('"sv_mapRotation" is: "^7" default: "^7"')).toEqual(
      [],
    );
  });

  it('returns an empty array for unrecognized input', () => {
    expect(parseMapRotation('')).toEqual([]);
  });
});

/** Builds a status table whose column widths exactly match the separator dashes. */
function buildStatusTable(mapName: string, rows: string[][]): string {
  const header = [
    'num',
    'score',
    'ping',
    'name',
    'lastmsg',
    'address',
    'qport',
    'rate',
  ];
  const widths = [3, 5, 4, 15, 7, 21, 5, 5];
  const pad = (value: string, width: number) =>
    value.length >= width ? value : value.padEnd(width);
  const headerLine = header.map((name, i) => pad(name, widths[i])).join(' ');
  const separatorLine = widths.map((width) => '-'.repeat(width)).join(' ');
  const dataLines = rows.map((cols) =>
    cols.map((value, i) => pad(value, widths[i])).join(' '),
  );
  return [`map: ${mapName}`, headerLine, separatorLine, ...dataLines].join(
    '\n',
  );
}

describe('parseRconStatusTable', () => {
  it('parses map name and the player table, including split IP/port and color-stripped names', () => {
    const table = buildStatusTable('mp_toujane', [
      [
        '0',
        '5',
        '42',
        '^1Player^7One',
        '0',
        '123.45.67.89:12345',
        '54321',
        '25000',
      ],
      ['1', '0', '12', 'PlayerTwo', '3', '98.76.54.32:5555', '11111', '20000'],
    ]);

    const status = parseRconStatusTable(table);

    expect(status.mapName).toBe('mp_toujane');
    expect(status.players).toEqual([
      {
        num: 0,
        score: 5,
        ping: 42,
        name: 'PlayerOne',
        lastmsg: 0,
        ip: '123.45.67.89',
        port: 12345,
        qport: 54321,
        rate: 25000,
      },
      {
        num: 1,
        score: 0,
        ping: 12,
        name: 'PlayerTwo',
        lastmsg: 3,
        ip: '98.76.54.32',
        port: 5555,
        qport: 11111,
        rate: 20000,
      },
    ]);
  });

  it('returns an empty player list when there is no table (e.g. unexpected output)', () => {
    const status = parseRconStatusTable('some unrelated print output');
    expect(status.players).toEqual([]);
  });

  it('skips blank lines after the table', () => {
    const table = buildStatusTable('mp_toujane', [
      ['0', '5', '42', 'Solo', '0', '1.2.3.4:1000', '1', '20000'],
    ]);
    const status = parseRconStatusTable(`${table}\n\n`);
    expect(status.players).toHaveLength(1);
  });

  it("parses a guid column, and recovers from a real server's off-by-one column drift", () => {
    // Captured verbatim from a real dedicated server (docs/PLAN.md §2.4 GUID-0 verification):
    // its data row is consistently 1 character narrower than its own header/separator claims
    // for every column from `address` onward, which fixed-width slicing alone misparses (the
    // `lastmsg` value bleeds into what would otherwise be read as the IP).
    const table = [
      'map: mp_burgundy',
      'num score ping guid   name            lastmsg address               qport rate',
      '--- ----- ---- ------ --------------- ------- --------------------- ----- -----',
      '  0     0   48      0 const^7                 0 172.18.0.1:-27419      1199 25000',
      '',
    ].join('\n');

    const status = parseRconStatusTable(table);

    expect(status.mapName).toBe('mp_burgundy');
    expect(status.players).toEqual([
      {
        num: 0,
        score: 0,
        ping: 48,
        guid: '0',
        name: 'const',
        lastmsg: 0,
        ip: '172.18.0.1',
        // Raw text is the signed-16-bit wraparound of 38117 (see status-parser.ts's
        // unwrapSignedPort) — the engine prints high ports through a signed formatter.
        port: 38117,
        qport: 1199,
        rate: 25000,
      },
    ]);
  });

  it('parses names longer than their column, and names with spaces (a real busy server)', () => {
    // Rows from a real public server (2026-10-04), IPs replaced with documentation addresses.
    // Every name here overflows the 15-character name column, pushing the rest of its row right;
    // the old parser read e.g. "0" or "50" as these players' IP.
    const table = [
      'map: mp_decoy',
      'num score ping guid   name            lastmsg address               qport rate',
      '--- ----- ---- ------ --------------- ------- --------------------- ----- -----',
      '  2    12   91      0 ^^20Persian^^51Gulf^7       0 198.51.100.2:22633    1264 25000',
      '  8    30  101      0 Pro100Nik#^2791^7        50 198.51.100.8:-11770    1858 25000',
      ' 11     0   83 990164 Pro100Nik#^2235^7         0 198.51.100.11:25460    5087 25000',
      ' 13    61   67      0 ^1=[^3JFF^1]^3jc^5Van^3Damme^7      0 198.51.100.13:28960     915 25000',
      ' 28   116   69      0 ^26o/IoTHuK ууу^7         0 198.51.100.28:28960   4075 25000',
      '',
    ].join('\n');

    const players = parseRconStatusTable(table).players;

    expect(
      players.map(({ num, guid, name, lastmsg, ip, port, qport }) => ({
        num,
        guid,
        name,
        lastmsg,
        ip,
        port,
        qport,
      })),
    ).toEqual([
      {
        num: 2,
        guid: '0',
        name: '^0Persian^1Gulf',
        lastmsg: 0,
        ip: '198.51.100.2',
        port: 22633,
        qport: 1264,
      },
      {
        num: 8,
        guid: '0',
        name: 'Pro100Nik#791',
        lastmsg: 50,
        ip: '198.51.100.8',
        port: 53766,
        qport: 1858,
      },
      {
        num: 11,
        guid: '990164',
        name: 'Pro100Nik#235',
        lastmsg: 0,
        ip: '198.51.100.11',
        port: 25460,
        qport: 5087,
      },
      {
        num: 13,
        guid: '0',
        name: '=[JFF]jcVanDamme',
        lastmsg: 0,
        ip: '198.51.100.13',
        port: 28960,
        qport: 915,
      },
      {
        num: 28,
        guid: '0',
        name: '6o/IoTHuK ууу',
        lastmsg: 0,
        ip: '198.51.100.28',
        port: 28960,
        qport: 4075,
      },
    ]);
  });

  it('un-wraps a signed-16-bit port above 32767', () => {
    const table = buildStatusTable('mp_toujane', [
      ['0', '0', '10', 'Solo', '0', '1.2.3.4:-12605', '990', '25000'],
    ]);

    const status = parseRconStatusTable(table);

    expect(status.players[0].port).toBe(52931);
  });
});
