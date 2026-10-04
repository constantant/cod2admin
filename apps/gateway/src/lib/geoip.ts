import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Reader, type CountryResponse } from 'maxmind';

/**
 * IP → country, for showing admins where a player connects from (`/players`, report cards, `/bans`).
 *
 * Offline on purpose: lookups use DB-IP's free "IP to Country Lite" database (CC BY 4.0 —
 * attribution is in /help and the README), downloaded by the bot itself and refreshed monthly. No
 * player IP is ever sent to a third-party lookup service, and lookups keep working where such
 * services are slow, rate-limited or blocked.
 */

export interface IpCountry {
  /** ISO 3166-1 alpha-2 code, or `LAN` for private/local addresses. */
  code: string;
  /** English name, e.g. "Russia". */
  name: string;
}

export interface CountryLookup {
  lookup(ip: string): IpCountry | undefined;
}

/** Used when the feature is off or no database could be loaded yet — shows nothing extra. */
export const NO_COUNTRY_LOOKUP: CountryLookup = { lookup: () => undefined };

const LAN: IpCountry = { code: 'LAN', name: 'LAN' };

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Private, loopback, link-local, carrier-grade NAT and "this network" IPv4 ranges. */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Regional-indicator flag emoji for an ISO code, e.g. "RU" → 🇷🇺. */
export function flagEmoji(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) {
    return '';
  }
  return String.fromCodePoint(...[...code].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
}

/** `🇷🇺 RU` — for compact lists like `/players` and `/bans`. */
export function formatCountryShort(country: IpCountry): string {
  return country.code === 'LAN' ? 'LAN' : `${flagEmoji(country.code)} ${country.code}`;
}

/** `🇷🇺 Russia` — for the report card, which has room for the full name. */
export function formatCountryLong(country: IpCountry): string {
  return country.code === 'LAN' ? 'LAN' : `${flagEmoji(country.code)} ${country.name}`;
}

/** The slice of maxmind's `Reader` this needs — lets tests use a fake instead of a real .mmdb. */
export interface CountryReader {
  get(ip: string): CountryResponse | null;
}

/** A `CountryLookup` whose database can be swapped while the bot runs (monthly refresh). */
export class GeoIpDatabase implements CountryLookup {
  private reader: CountryReader | undefined;

  get loaded(): boolean {
    return this.reader !== undefined;
  }

  setReader(reader: CountryReader): void {
    this.reader = reader;
  }

  lookup(ip: string): IpCountry | undefined {
    // Only full dotted-quad IPv4 (what CoD2 reports). maxmind would otherwise accept shorthand
    // like "50" as 0.0.0.50 and answer with a country for it.
    if (!IPV4_PATTERN.test(ip)) {
      return undefined;
    }
    if (isPrivateIpv4(ip)) {
      return LAN;
    }
    if (!this.reader) {
      return undefined;
    }
    let record: CountryResponse | null;
    try {
      record = this.reader.get(ip);
    } catch {
      return undefined; // not an IP address at all (e.g. a bot's "bot" address in `status`)
    }
    const country = record?.country;
    if (!country?.iso_code) {
      return undefined;
    }
    return { code: country.iso_code, name: country.names?.en ?? country.iso_code };
  }
}

/** Parses a raw (un-gzipped) .mmdb file, rejecting anything that isn't a country database. */
export function parseCountryDatabase(buffer: Buffer): CountryReader {
  const reader = new Reader<CountryResponse>(buffer);
  if (!/country/i.test(reader.metadata.databaseType)) {
    throw new Error(`Not a country database: ${reader.metadata.databaseType}`);
  }
  return reader;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** DB-IP publishes `dbip-country-lite-YYYY-MM.mmdb.gz` monthly. */
export function dbIpDownloadUrl(date: Date): string {
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`;
}

export interface GeoIpUpdaterOptions {
  database: GeoIpDatabase;
  /** Where the .mmdb lives. Loaded on start; overwritten by downloads when `autoDownload` is on. */
  filePath: string;
  /** Off when the admin supplied the file themselves (`GEOIP_DB_PATH`) — then it's only loaded. */
  autoDownload: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  parse?: (buffer: Buffer) => CountryReader;
  log?: (message: string) => void;
}

/**
 * Loads the database from disk, downloading it first if it's missing or older than 30 days, and
 * re-checks daily so a long-running bot picks up each monthly release. Never throws: when no
 * database is available the lookup just returns nothing, and every other feature is unaffected.
 */
export class GeoIpUpdater {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly parse: (buffer: Buffer) => CountryReader;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: GeoIpUpdaterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.parse = options.parse ?? parseCountryDatabase;
    this.log = options.log ?? ((message) => console.log(message));
  }

  async start(): Promise<void> {
    await this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** One load-or-refresh pass. Public for tests. */
  async check(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const { database, filePath, autoDownload } = this.options;
      const fileStat = await stat(filePath).catch(() => undefined);

      if (fileStat && !database.loaded) {
        try {
          database.setReader(this.parse(await readFile(filePath)));
          this.log(`IP country database loaded from ${filePath}`);
        } catch (error) {
          this.log(`IP country database at ${filePath} is unreadable (${String(error)})`);
        }
      }

      const stale = !fileStat || this.now().getTime() - fileStat.mtime.getTime() > MAX_AGE_MS;
      if (autoDownload && (stale || !database.loaded)) {
        await this.download();
      }
    } finally {
      this.running = false;
    }
  }

  /** Tries this month's file, then last month's (a new month's file may not be published yet). */
  private async download(): Promise<void> {
    const now = this.now();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    for (const url of [dbIpDownloadUrl(now), dbIpDownloadUrl(lastMonth)]) {
      try {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok) {
          continue;
        }
        const buffer = gunzipSync(Buffer.from(await response.arrayBuffer()));
        const reader = this.parse(buffer);
        const tmpPath = `${this.options.filePath}.tmp`;
        await writeFile(tmpPath, buffer);
        await rename(tmpPath, this.options.filePath);
        this.options.database.setReader(reader);
        this.log(`IP country database updated from ${url}`);
        return;
      } catch (error) {
        this.log(`IP country database download from ${url} failed: ${String(error)}`);
      }
    }
    this.log(
      this.options.database.loaded
        ? 'IP country database not updated — keeping the current one.'
        : 'No IP country database available yet — countries won\'t be shown until a download succeeds.',
    );
  }
}

/** `🇷🇺 RU` for an IP, or undefined when the country isn't known. */
export function describeIpShort(lookup: CountryLookup, ip: string | undefined): string | undefined {
  const country = ip ? lookup.lookup(ip) : undefined;
  return country ? formatCountryShort(country) : undefined;
}

/** `🇷🇺 Russia` for an IP, or undefined when the country isn't known. */
export function describeIpLong(lookup: CountryLookup, ip: string | undefined): string | undefined {
  const country = ip ? lookup.lookup(ip) : undefined;
  return country ? formatCountryLong(country) : undefined;
}
