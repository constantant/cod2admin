import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeVpnLong,
  describeVpnShort,
  IpRangeSet,
  joinIpLabels,
  NO_VPN_LOOKUP,
  parseVpnNetworks,
  VPN_LISTS,
  VpnListUpdater,
  VpnRangeDatabase,
  type VpnListKind,
} from './vpn-ranges.js';

describe('IpRangeSet', () => {
  it('matches single addresses and CIDR ranges, inclusive of both ends', () => {
    const set = IpRangeSet.parse('5.9.0.0/16\n171.25.193.20\n');

    expect(set.has('5.9.0.0')).toBe(true);
    expect(set.has('5.9.10.10')).toBe(true);
    expect(set.has('5.9.255.255')).toBe(true);
    expect(set.has('5.10.0.0')).toBe(false);
    expect(set.has('171.25.193.20')).toBe(true);
    expect(set.has('171.25.193.21')).toBe(false);
  });

  it('merges overlapping and adjacent ranges', () => {
    const set = IpRangeSet.parse('10.0.0.0/24\n10.0.1.0/24\n10.0.0.128/25\n');

    expect(set.size).toBe(1);
    expect(set.has('10.0.1.255')).toBe(true);
  });

  it('aligns a CIDR whose address is not the network address', () => {
    expect(IpRangeSet.parse('1.2.3.77/24').has('1.2.3.1')).toBe(true);
  });

  it('skips comments, blanks, IPv6 and malformed lines', () => {
    const set = IpRangeSet.parse('# comment\n\n2001:db8::/32\n1.2.3.4/33\n300.1.1.1\n1.2.3.4/\nnot an ip\n8.8.8.8\n');

    expect(set.size).toBe(1);
    expect(set.has('8.8.8.8')).toBe(true);
  });

  it('never matches things that are not IPv4 addresses', () => {
    const set = IpRangeSet.parse('0.0.0.0/0');

    expect(set.has('bot')).toBe(false);
    expect(set.has('50')).toBe(false);
    expect(set.has('1.2.3.256')).toBe(false);
    expect(set.has('1.2.3.4')).toBe(true);
  });
});

describe('VpnRangeDatabase and labels', () => {
  function database(): VpnRangeDatabase {
    const db = new VpnRangeDatabase();
    db.setList('tor', IpRangeSet.parse('5.9.10.10'));
    db.setList('vpn', IpRangeSet.parse('5.9.10.0/24\n45.0.0.1'));
    db.setList('hosting', IpRangeSet.parse('5.9.0.0/16\n3.5.140.0/22'));
    return db;
  }

  it('reports the most specific kind for an IP on several lists', () => {
    const db = database();

    expect(db.lookup('5.9.10.10')).toBe('tor');
    expect(db.lookup('5.9.10.11')).toBe('vpn');
    expect(db.lookup('5.9.11.1')).toBe('hosting');
    expect(db.lookup('188.19.61.1')).toBeUndefined();
  });

  it('describes flagged IPs short and long, and nothing otherwise', () => {
    const db = database();

    expect(describeVpnShort(db, '45.0.0.1')).toBe('🛡 VPN');
    expect(describeVpnShort(db, '3.5.140.2')).toBe('🛡 hosting');
    expect(describeVpnLong(db, '5.9.10.10')).toBe('🛡 Tor exit');
    expect(describeVpnLong(db, '3.5.140.2')).toBe('🛡 hosting IP (likely VPN/proxy)');
    expect(describeVpnShort(db, '188.19.61.1')).toBeUndefined();
    expect(describeVpnShort(db, undefined)).toBeUndefined();
    expect(describeVpnShort(NO_VPN_LOOKUP, '45.0.0.1')).toBeUndefined();
  });

  it('flags provider networks named with /vpnnets, ahead of the hosting list', () => {
    const asns: Record<string, number> = { '2.27.5.10': 202226, '5.9.11.1': 24940, '188.19.61.1': 12389 };
    const db = new VpnRangeDatabase((ip) => asns[ip]);
    db.setList('tor', IpRangeSet.parse('5.9.10.10'));
    db.setList('hosting', IpRangeSet.parse('5.9.0.0/16'));
    db.setNetworks([202226, 24940]);

    expect(db.lookup('2.27.5.10')).toBe('provider');
    expect(db.lookup('5.9.11.1')).toBe('provider');
    expect(db.lookup('5.9.10.10')).toBe('tor');
    expect(db.lookup('188.19.61.1')).toBeUndefined();
    expect(describeVpnShort(db, '2.27.5.10')).toBe('🛡 VPN');
    expect(describeVpnLong(db, '2.27.5.10')).toBe('🛡 VPN (provider on /vpnnets)');

    db.setNetworks([]);
    expect(db.lookup('2.27.5.10')).toBeUndefined();
    expect(db.lookup('5.9.11.1')).toBe('hosting');
  });

  it('reads the stored /vpnnets setting, dropping malformed entries', () => {
    expect(parseVpnNetworks([{ asn: 202226, name: 'Great Flower' }, { asn: 9009 }, { asn: 9010, name: '' }])).toEqual([
      { asn: 202226, name: 'Great Flower' },
      { asn: 9009 },
      { asn: 9010 },
    ]);
    expect(parseVpnNetworks([{ asn: '1' }, { asn: -5 }, { asn: 1.5 }, null, 'AS1'])).toEqual([]);
    expect(parseVpnNetworks(undefined)).toEqual([]);
    expect(parseVpnNetworks({ asn: 1 })).toEqual([]);
  });

  it('joins only the labels that are known', () => {
    expect(joinIpLabels('🇳🇱 NL', '🛡 VPN')).toBe('🇳🇱 NL 🛡 VPN');
    expect(joinIpLabels(undefined, '🛡 VPN')).toBe('🛡 VPN');
    expect(joinIpLabels('🇷🇺 RU', undefined)).toBe('🇷🇺 RU');
    expect(joinIpLabels(undefined, undefined)).toBeUndefined();
  });
});

describe('VpnListUpdater', () => {
  const NOW = new Date('2026-10-07T12:00:00Z');
  /** A list big enough to pass the "real list" size check, with one recognisable range per kind. */
  const LIST_TEXT: Record<VpnListKind, string> = {
    tor: listOf('171.25.193.20'),
    vpn: listOf('45.0.0.1'),
    hosting: listOf('5.9.0.0/16'),
  };
  let dir: string;

  function listOf(marker: string): string {
    const filler = Array.from({ length: 150 }, (_, index) => `100.${Math.floor(index / 250)}.${index % 250}.1`);
    return [marker, ...filler].join('\n');
  }

  function okFetch(): typeof fetch {
    return vi.fn(async (url: string) => {
      const kind = VPN_LISTS.find((list) => list.url === url)?.kind;
      return kind ? new Response(LIST_TEXT[kind]) : new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  }

  function updater(fetchImpl: typeof fetch = okFetch()) {
    const database = new VpnRangeDatabase();
    const instance = new VpnListUpdater({ database, dir, fetchImpl, now: () => NOW, log: () => undefined });
    return { instance, database, fetchImpl };
  }

  async function writeAll(age = 0): Promise<void> {
    for (const { kind } of VPN_LISTS) {
      const file = join(dir, `${kind}.txt`);
      await writeFile(file, LIST_TEXT[kind]);
      const time = new Date(NOW.getTime() - age);
      await utimes(file, time, time);
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vpn-lists-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads missing lists, saves them and starts flagging', async () => {
    const { instance, database } = updater();

    await instance.check();

    expect(database.lookup('171.25.193.20')).toBe('tor');
    expect(database.lookup('45.0.0.1')).toBe('vpn');
    expect(database.lookup('5.9.10.10')).toBe('hosting');
    expect(await readFile(join(dir, 'vpn.txt'), 'utf8')).toBe(LIST_TEXT.vpn);
  });

  it('loads fresh lists from disk without downloading', async () => {
    await writeAll();
    const { instance, database, fetchImpl } = updater();

    await instance.check();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(database.lookup('45.0.0.1')).toBe('vpn');
  });

  it('refreshes lists older than 7 days', async () => {
    await writeAll(8 * 24 * 60 * 60 * 1000);
    const { instance, fetchImpl } = updater();

    await instance.check();

    expect(fetchImpl).toHaveBeenCalledTimes(VPN_LISTS.length);
  });

  it('keeps the current lists when a refresh fails', async () => {
    await writeAll(8 * 24 * 60 * 60 * 1000);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const { instance, database } = updater(fetchImpl);

    await instance.check();

    expect(database.lookup('45.0.0.1')).toBe('vpn');
    expect(await readFile(join(dir, 'vpn.txt'), 'utf8')).toBe(LIST_TEXT.vpn);
  });

  it('rejects a download that is too small to be a real list', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>rate limited</html>\n1.2.3.4')) as unknown as typeof fetch;
    const { instance, database } = updater(fetchImpl);

    await instance.check();

    expect(database.loaded).toBe(false);
    await expect(readFile(join(dir, 'vpn.txt'))).rejects.toThrow();
  });
});
