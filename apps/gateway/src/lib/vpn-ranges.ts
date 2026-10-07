import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * IP → "is this a VPN, proxy or Tor exit?", for flagging players in `/players` and report cards.
 * Only a flag for admins: nothing is kicked or banned on it (a VPN exit IP is shared by strangers,
 * and VPNs are common among ordinary players in Russia — docs/PLAN.md §2.4 "VPNs").
 *
 * Offline for the same reason as geoip.ts: the bot downloads public lists itself and refreshes
 * them, so no player IP is ever sent to a lookup service. They only catch VPNs that run on data
 * centre servers (most commercial ones), not ones that route through home connections.
 */

/** `tor` — a Tor exit node; `vpn` — a known VPN range; `hosting` — a data centre, likely a VPN or proxy. */
export type VpnKind = 'tor' | 'vpn' | 'hosting';

export interface VpnLookup {
  lookup(ip: string): VpnKind | undefined;
}

/** Used when the feature is off or no list could be loaded yet — flags nothing. */
export const NO_VPN_LOOKUP: VpnLookup = { lookup: () => undefined };

/** The public lists, most specific first — an IP on several gets the first one's kind. */
export const VPN_LISTS: readonly { kind: VpnKind; url: string }[] = [
  { kind: 'tor', url: 'https://check.torproject.org/torbulkexitlist' },
  { kind: 'vpn', url: 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt' },
  { kind: 'hosting', url: 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt' },
];

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToNumber(ip: string): number | undefined {
  const match = IPV4_PATTERN.exec(ip);
  if (!match) {
    return undefined;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return undefined;
  }
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

/** Sorted, merged IPv4 ranges with binary-search lookup — the lists hold ~55k ranges. */
export class IpRangeSet {
  private constructor(
    private readonly starts: Float64Array,
    private readonly ends: Float64Array,
  ) {}

  get size(): number {
    return this.starts.length;
  }

  /**
   * Parses one address or CIDR per line (`1.2.3.4`, `1.2.3.0/24`). Comments, blank lines, IPv6
   * and anything else malformed are skipped, so a list format change can't crash the bot.
   */
  static parse(text: string): IpRangeSet {
    const ranges: [number, number][] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      const [ip, bitsText] = line.split('/');
      const start = ipv4ToNumber(ip ?? '');
      const bits = bitsText === undefined ? 32 : Number(bitsText);
      if (start === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32 || (bitsText !== undefined && !/^\d+$/.test(bitsText))) {
        continue;
      }
      const size = 2 ** (32 - bits);
      const aligned = Math.floor(start / size) * size;
      ranges.push([aligned, aligned + size - 1]);
    }
    ranges.sort((a, b) => a[0] - b[0]);

    const merged: [number, number][] = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1] + 1) {
        last[1] = Math.max(last[1], range[1]);
      } else {
        merged.push([range[0], range[1]]);
      }
    }
    return new IpRangeSet(
      Float64Array.from(merged, ([start]) => start),
      Float64Array.from(merged, ([, end]) => end),
    );
  }

  has(ip: string): boolean {
    const value = ipv4ToNumber(ip);
    if (value === undefined) {
      return false;
    }
    let low = 0;
    let high = this.starts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (value < this.starts[mid]!) {
        high = mid - 1;
      } else if (value > this.ends[mid]!) {
        low = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  }
}

/** A `VpnLookup` whose lists can be swapped while the bot runs (periodic refresh). */
export class VpnRangeDatabase implements VpnLookup {
  private readonly sets = new Map<VpnKind, IpRangeSet>();

  get loaded(): boolean {
    return this.sets.size > 0;
  }

  setList(kind: VpnKind, set: IpRangeSet): void {
    this.sets.set(kind, set);
  }

  lookup(ip: string): VpnKind | undefined {
    return VPN_LISTS.find(({ kind }) => this.sets.get(kind)?.has(ip))?.kind;
  }
}

const SHORT_LABELS: Record<VpnKind, string> = { tor: '🛡 Tor', vpn: '🛡 VPN', hosting: '🛡 hosting' };
const LONG_LABELS: Record<VpnKind, string> = {
  tor: '🛡 Tor exit',
  vpn: '🛡 VPN',
  hosting: '🛡 hosting IP (likely VPN/proxy)',
};

/** `🛡 VPN` for `/players`, or undefined when the IP isn't flagged. */
export function describeVpnShort(lookup: VpnLookup, ip: string | undefined): string | undefined {
  const kind = ip ? lookup.lookup(ip) : undefined;
  return kind ? SHORT_LABELS[kind] : undefined;
}

/** `🛡 hosting IP (likely VPN/proxy)` for report cards, or undefined when the IP isn't flagged. */
export function describeVpnLong(lookup: VpnLookup, ip: string | undefined): string | undefined {
  const kind = ip ? lookup.lookup(ip) : undefined;
  return kind ? LONG_LABELS[kind] : undefined;
}

/** Joins the labels that are known (`🇳🇱 NL 🛡 VPN`), or undefined when none is. */
export function joinIpLabels(...labels: (string | undefined)[]): string | undefined {
  const known = labels.filter((label): label is string => Boolean(label));
  return known.length > 0 ? known.join(' ') : undefined;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** A real list has thousands of entries — anything much smaller is an error page, not a list. */
const MIN_ENTRIES = 100;

export interface VpnListUpdaterOptions {
  database: VpnRangeDatabase;
  /** Directory holding one `<kind>.txt` per list. Loaded on start, refreshed weekly. */
  dir: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * Loads each list from disk, downloading it first if it's missing or older than 7 days, and
 * re-checks daily. Never throws: a list that can't be loaded or downloaded just flags nothing, and
 * a failed refresh keeps the previous copy.
 */
export class VpnListUpdater {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: VpnListUpdaterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
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

  /** One load-or-refresh pass over every list. Public for tests. */
  async check(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await mkdir(this.options.dir, { recursive: true }).catch(() => undefined);
      for (const list of VPN_LISTS) {
        await this.checkList(list.kind, list.url);
      }
    } finally {
      this.running = false;
    }
  }

  private async checkList(kind: VpnKind, url: string): Promise<void> {
    const filePath = path.join(this.options.dir, `${kind}.txt`);
    const fileStat = await stat(filePath).catch(() => undefined);
    let loaded = false;
    if (fileStat) {
      try {
        this.options.database.setList(kind, IpRangeSet.parse(await readFile(filePath, 'utf8')));
        loaded = true;
      } catch (error) {
        this.log(`VPN list ${filePath} is unreadable (${String(error)})`);
      }
    }

    const stale = !fileStat || this.now().getTime() - fileStat.mtime.getTime() > MAX_AGE_MS;
    if (!stale && loaded) {
      return;
    }
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const set = IpRangeSet.parse(text);
      if (set.size < MIN_ENTRIES) {
        throw new Error(`only ${set.size} entries, expected a real list`);
      }
      const tmpPath = `${filePath}.tmp`;
      await writeFile(tmpPath, text);
      await rename(tmpPath, filePath);
      this.options.database.setList(kind, set);
      this.log(`VPN list "${kind}" updated from ${url} (${set.size} ranges)`);
    } catch (error) {
      this.log(
        `VPN list "${kind}" download from ${url} failed: ${String(error)}` +
          (loaded ? ' — keeping the current one.' : " — it won't flag anything until a download succeeds."),
      );
    }
  }
}
