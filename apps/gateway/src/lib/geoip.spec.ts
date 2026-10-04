import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { CountryResponse } from 'maxmind';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dbIpDownloadUrl,
  describeIpLong,
  describeIpShort,
  flagEmoji,
  GeoIpDatabase,
  GeoIpUpdater,
  NO_COUNTRY_LOOKUP,
  type CountryReader,
} from './geoip.js';

function fakeReader(table: Record<string, string>): CountryReader {
  return {
    get(ip: string) {
      if (!/^[\d.]+$/.test(ip)) {
        throw new Error(`invalid IP ${ip}`);
      }
      const code = table[ip];
      return code ? ({ country: { iso_code: code, names: { en: `Name of ${code}` } } } as CountryResponse) : null;
    },
  };
}

function databaseWith(table: Record<string, string>): GeoIpDatabase {
  const database = new GeoIpDatabase();
  database.setReader(fakeReader(table));
  return database;
}

describe('formatting', () => {
  it('builds flag emoji from ISO codes', () => {
    expect(flagEmoji('RU')).toBe('🇷🇺');
    expect(flagEmoji('NL')).toBe('🇳🇱');
    expect(flagEmoji('LAN')).toBe('');
  });

  it('describes an IP as "flag CODE" (short) or "flag Name" (long)', () => {
    const database = databaseWith({ '77.37.210.26': 'RU' });

    expect(describeIpShort(database, '77.37.210.26')).toBe('🇷🇺 RU');
    expect(describeIpLong(database, '77.37.210.26')).toBe('🇷🇺 Name of RU');
  });

  it('describes nothing for unknown, missing or invalid IPs, or when the feature is off', () => {
    const database = databaseWith({});

    expect(describeIpShort(database, '8.8.8.8')).toBeUndefined();
    expect(describeIpShort(database, undefined)).toBeUndefined();
    expect(describeIpShort(database, 'bot')).toBeUndefined();
    // Real bug: a misparsed `status` row gave "50" as an IP, which maxmind reads as 0.0.0.50.
    expect(describeIpShort(databaseWith({ '50': 'US' }), '50')).toBeUndefined();
    expect(describeIpShort(NO_COUNTRY_LOOKUP, '77.37.210.26')).toBeUndefined();
  });
});

describe('GeoIpDatabase', () => {
  it.each(['10.0.0.5', '192.168.1.5', '172.20.0.1', '127.0.0.1', '100.64.1.1', '169.254.0.9'])(
    'labels private address %s as LAN, even before a database is loaded',
    (ip) => {
      expect(new GeoIpDatabase().lookup(ip)).toEqual({ code: 'LAN', name: 'LAN' });
      expect(describeIpShort(new GeoIpDatabase(), ip)).toBe('LAN');
    },
  );

  it('does not treat public addresses next to private ranges as LAN', () => {
    const database = databaseWith({ '172.32.0.1': 'US', '11.0.0.1': 'US' });

    expect(database.lookup('172.32.0.1')?.code).toBe('US');
    expect(database.lookup('11.0.0.1')?.code).toBe('US');
  });

  it('returns nothing for public IPs until a database is loaded', () => {
    expect(new GeoIpDatabase().lookup('77.37.210.26')).toBeUndefined();
  });
});

describe('dbIpDownloadUrl', () => {
  it('uses the UTC year and zero-padded month', () => {
    expect(dbIpDownloadUrl(new Date('2026-03-01T00:30:00Z'))).toBe(
      'https://download.db-ip.com/free/dbip-country-lite-2026-03.mmdb.gz',
    );
  });
});

describe('GeoIpUpdater', () => {
  const NOW = new Date('2026-10-04T12:00:00Z');
  const DB_BYTES = Buffer.from('fake mmdb bytes');
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geoip-test-'));
    filePath = join(dir, 'dbip-country-lite.mmdb');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function okResponse(): Response {
    return new Response(gzipSync(DB_BYTES), { status: 200 });
  }

  function updater(overrides: { fetchImpl?: typeof fetch; autoDownload?: boolean; database?: GeoIpDatabase } = {}) {
    const database = overrides.database ?? new GeoIpDatabase();
    const parse = vi.fn(() => fakeReader({ '77.37.210.26': 'RU' }));
    const fetchImpl = overrides.fetchImpl ?? vi.fn(async () => okResponse());
    const instance = new GeoIpUpdater({
      database,
      filePath,
      autoDownload: overrides.autoDownload ?? true,
      fetchImpl,
      now: () => NOW,
      parse,
      log: () => undefined,
    });
    return { instance, database, parse, fetchImpl };
  }

  it('downloads this month\'s database when none is on disk, saves it, and starts answering lookups', async () => {
    const { instance, database, fetchImpl } = updater();

    await instance.check();

    expect(fetchImpl).toHaveBeenCalledWith(dbIpDownloadUrl(NOW), expect.anything());
    expect(await readFile(filePath)).toEqual(DB_BYTES);
    expect(database.lookup('77.37.210.26')?.code).toBe('RU');
  });

  it('falls back to last month\'s file when this month\'s isn\'t published yet', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('2026-10') ? new Response('', { status: 404 }) : okResponse(),
    ) as unknown as typeof fetch;
    const { instance, database } = updater({ fetchImpl });

    await instance.check();

    expect(fetchImpl).toHaveBeenLastCalledWith(expect.stringContaining('2026-09'), expect.anything());
    expect(database.loaded).toBe(true);
  });

  it('loads a fresh file from disk without downloading', async () => {
    await writeFile(filePath, DB_BYTES);
    const { instance, database, fetchImpl } = updater();

    await instance.check();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(database.loaded).toBe(true);
  });

  it('refreshes a file older than 30 days', async () => {
    await writeFile(filePath, DB_BYTES);
    const old = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
    await utimes(filePath, old, old);
    const { instance, fetchImpl } = updater();

    await instance.check();

    expect(fetchImpl).toHaveBeenCalled();
  });

  it('keeps the current database when a refresh fails', async () => {
    await writeFile(filePath, DB_BYTES);
    const old = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
    await utimes(filePath, old, old);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const { instance, database } = updater({ fetchImpl });

    await instance.check();

    expect(database.loaded).toBe(true);
    expect(await readFile(filePath)).toEqual(DB_BYTES);
  });

  it('never downloads when the admin supplied the file (GEOIP_DB_PATH)', async () => {
    const { instance, database, fetchImpl } = updater({ autoDownload: false });

    await instance.check();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(database.loaded).toBe(false);
  });
});
