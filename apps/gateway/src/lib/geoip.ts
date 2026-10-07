import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Reader, type AsnResponse, type CityResponse, type CountryResponse } from 'maxmind';

/**
 * IP → country (optionally city) and provider, for showing admins where a player connects from
 * (country/city in `/players`, report cards and `/bans`; provider in `/players` and report cards).
 *
 * Offline on purpose: lookups use DB-IP's free "IP to Country Lite" (or, with
 * `GEOIP_CITY_ENABLED`, "IP to City Lite") and "IP to ASN Lite" databases (CC BY 4.0 — attribution
 * is in /help and the README), downloaded by the bot itself and refreshed monthly. No player IP is ever sent to a third-party lookup service, and lookups keep working
 * where such services are slow, rate-limited or blocked.
 */

export interface IpCountry {
  /** ISO 3166-1 alpha-2 code, or `LAN` for private/local addresses. */
  code: string;
  /** English name, e.g. "Russia". */
  name: string;
  /** English city name, e.g. "Yekaterinburg" — only from the city database. */
  city?: string;
  /** English region name, e.g. "Sverdlovsk Oblast" — only from the city database. */
  region?: string;
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

/** `🇷🇺 RU`, or `🇷🇺 RU, Yekaterinburg` with the city database — for `/players` and `/bans`. */
export function formatCountryShort(country: IpCountry): string {
  if (country.code === 'LAN') {
    return 'LAN';
  }
  const place = country.city ?? country.region;
  return `${flagEmoji(country.code)} ${country.code}${place ? `, ${place}` : ''}`;
}

/**
 * `🇷🇺 Russia`, or `🇷🇺 Russia, Yekaterinburg (Sverdlovsk Oblast)` with the city database — for the
 * report card. The region is there because the free database often names the provider's hub city
 * rather than the player's (found live: a Surgut player shown in Khanty-Mansiysk, same region).
 */
export function formatCountryLong(country: IpCountry): string {
  if (country.code === 'LAN') {
    return 'LAN';
  }
  const { city, region } = country;
  const place = city && region && city !== region ? `${city} (${region})` : (city ?? region);
  return `${flagEmoji(country.code)} ${country.name}${place ? `, ${place}` : ''}`;
}

/**
 * The slice of maxmind's `Reader` this needs — lets tests use a fake instead of a real .mmdb. A
 * country database answers without `city`/`subdivisions`; a city database adds them.
 */
export interface CountryReader {
  get(ip: string): CountryResponse | CityResponse | null;
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
    let record: CityResponse | null;
    try {
      record = this.reader.get(ip);
    } catch {
      return undefined; // not an IP address at all (e.g. a bot's "bot" address in `status`)
    }
    const country = record?.country;
    if (!country?.iso_code) {
      return undefined;
    }
    const result: IpCountry = { code: country.iso_code, name: country.names?.en ?? country.iso_code };
    const city = record?.city?.names?.en?.trim();
    const region = record?.subdivisions?.[0]?.names?.en?.trim();
    if (city) {
      result.city = city;
    }
    if (region) {
      result.region = region;
    }
    return result;
  }
}

/** Parses a raw (un-gzipped) .mmdb file, rejecting anything that isn't a country database. */
export function parseCountryDatabase(buffer: Buffer): CountryReader {
  return parseLocationDatabase(buffer, /country/i, 'country');
}

/** Parses a raw (un-gzipped) .mmdb file, rejecting anything that isn't a city database. */
export function parseCityDatabase(buffer: Buffer): CountryReader {
  return parseLocationDatabase(buffer, /city/i, 'city');
}

function parseLocationDatabase(buffer: Buffer, type: RegExp, label: string): CountryReader {
  const reader = new Reader<CityResponse>(buffer);
  if (!type.test(reader.metadata.databaseType)) {
    throw new Error(`Not a ${label} database: ${reader.metadata.databaseType}`);
  }
  return reader;
}

/** IP → the provider (ISP or hosting company) that owns it, e.g. "PJSC Rostelecom". */
export interface ProviderLookup {
  lookup(ip: string): string | undefined;
  /** The provider's network number (ASN), e.g. 12389 — what `/vpnnets` matches on. */
  asn(ip: string): number | undefined;
}

/** Used when the feature is off or no database could be loaded yet — shows nothing extra. */
export const NO_PROVIDER_LOOKUP: ProviderLookup = { lookup: () => undefined, asn: () => undefined };

/** The slice of maxmind's `Reader` this needs — lets tests use a fake instead of a real .mmdb. */
export interface AsnReader {
  get(ip: string): AsnResponse | null;
}

/** A `ProviderLookup` whose database can be swapped while the bot runs (monthly refresh). */
export class AsnDatabase implements ProviderLookup {
  private reader: AsnReader | undefined;

  get loaded(): boolean {
    return this.reader !== undefined;
  }

  setReader(reader: AsnReader): void {
    this.reader = reader;
  }

  lookup(ip: string): string | undefined {
    return this.record(ip)?.autonomous_system_organization?.trim() || undefined;
  }

  asn(ip: string): number | undefined {
    return this.record(ip)?.autonomous_system_number || undefined;
  }

  private record(ip: string): AsnResponse | undefined {
    // Same guards as GeoIpDatabase.lookup; a private address has no provider worth showing.
    if (!IPV4_PATTERN.test(ip) || isPrivateIpv4(ip) || !this.reader) {
      return undefined;
    }
    try {
      return this.reader.get(ip) ?? undefined;
    } catch {
      return undefined;
    }
  }
}

/** Parses a raw (un-gzipped) .mmdb file, rejecting anything that isn't an ASN database. */
export function parseAsnDatabase(buffer: Buffer): AsnReader {
  const reader = new Reader<AsnResponse>(buffer);
  if (!/asn/i.test(reader.metadata.databaseType)) {
    throw new Error(`Not an ASN database: ${reader.metadata.databaseType}`);
  }
  return reader;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** DB-IP publishes `dbip-country-lite-YYYY-MM.mmdb.gz` monthly. */
export function dbIpDownloadUrl(date: Date): string {
  return dbIpUrl('country', date);
}

/** DB-IP publishes `dbip-asn-lite-YYYY-MM.mmdb.gz` monthly, alongside the country database. */
export function dbIpAsnDownloadUrl(date: Date): string {
  return dbIpUrl('asn', date);
}

/** DB-IP publishes `dbip-city-lite-YYYY-MM.mmdb.gz` monthly — ~60 MB, ~120 MB once loaded. */
export function dbIpCityDownloadUrl(date: Date): string {
  return dbIpUrl('city', date);
}

function dbIpUrl(kind: 'country' | 'asn' | 'city', date: Date): string {
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz`;
}

/** What `GeoIpUpdater` fills: a `GeoIpDatabase` or an `AsnDatabase`. */
export interface ReaderHolder<R> {
  readonly loaded: boolean;
  setReader(reader: R): void;
}

export interface GeoIpUpdaterOptions<R = CountryReader> {
  database: ReaderHolder<R>;
  /** Where the .mmdb lives. Loaded on start; overwritten by downloads when `autoDownload` is on. */
  filePath: string;
  /** Off when the admin supplied the file themselves (`GEOIP_DB_PATH`) — then it's only loaded. */
  autoDownload: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Defaults to the country database's parser and URL — pass both for the ASN database. */
  parse?: (buffer: Buffer) => R;
  downloadUrl?: (date: Date) => string;
  /** Names the database in log lines. Defaults to "IP country database". */
  label?: string;
  log?: (message: string) => void;
}

/**
 * Loads the database from disk, downloading it first if it's missing or older than 30 days, and
 * re-checks daily so a long-running bot picks up each monthly release. Never throws: when no
 * database is available the lookup just returns nothing, and every other feature is unaffected.
 */
export class GeoIpUpdater<R = CountryReader> {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly parse: (buffer: Buffer) => R;
  private readonly downloadUrl: (date: Date) => string;
  private readonly label: string;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: GeoIpUpdaterOptions<R>) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    // Without `parse`, R is the default CountryReader — the cast only restates that.
    this.parse = options.parse ?? (parseCountryDatabase as unknown as (buffer: Buffer) => R);
    this.downloadUrl = options.downloadUrl ?? dbIpDownloadUrl;
    this.label = options.label ?? 'IP country database';
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
          this.log(`${this.label} loaded from ${filePath}`);
        } catch (error) {
          this.log(`${this.label} at ${filePath} is unreadable (${String(error)})`);
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
    for (const url of [this.downloadUrl(now), this.downloadUrl(lastMonth)]) {
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
        this.log(`${this.label} updated from ${url}`);
        return;
      } catch (error) {
        this.log(`${this.label} download from ${url} failed: ${String(error)}`);
      }
    }
    this.log(
      this.options.database.loaded
        ? `${this.label} not updated — keeping the current one.`
        : `No ${this.label} available yet — nothing from it will be shown until a download succeeds.`,
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

/** Longest provider name `/players` shows before cutting it with "…" — some are 60+ characters. */
const SHORT_PROVIDER_LENGTH = 25;

/** The IP's provider, cut to fit a `/players` line, or undefined when unknown. */
export function describeProviderShort(lookup: ProviderLookup, ip: string | undefined): string | undefined {
  const provider = ip ? lookup.lookup(ip) : undefined;
  if (!provider || provider.length <= SHORT_PROVIDER_LENGTH) {
    return provider;
  }
  return `${provider.slice(0, SHORT_PROVIDER_LENGTH - 1).trimEnd()}…`;
}

/** The IP's provider in full, for report cards, or undefined when unknown. */
export function describeProviderLong(lookup: ProviderLookup, ip: string | undefined): string | undefined {
  return ip ? lookup.lookup(ip) : undefined;
}

/** `🇷🇺 RU · PJSC Rostelecom` — country and provider, either of which may be unknown. */
export function joinCountryAndProvider(country: string | undefined, provider: string | undefined): string | undefined {
  if (country && provider) {
    return `${country} · ${provider}`;
  }
  return country ?? provider;
}
