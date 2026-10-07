import type { Ban, BanIp } from '@cod2admin/ban-store';
import type { BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { describeIpLong, describeIpShort, NO_COUNTRY_LOOKUP, type CountryLookup } from '../geoip.js';
import { markdownTable, replyWithReport, reportDocument, reportFileName, type LongReply } from '../long-reply.js';

function formatExpiry(expiresAt: Date | null): string {
  return expiresAt ? `expires ${expiresAt.toISOString()}` : 'permanent';
}

function formatGuidBan(ban: Ban): string {
  const reason = ban.reason ? ` (${ban.reason})` : '';
  return `${ban.guid ?? 'unknown guid'} — ${ban.name}${reason} — ${formatExpiry(ban.expiresAt)} — banned on ${ban.serverAlias}`;
}

function formatIpBan(ban: BanIp, geoip: CountryLookup): string {
  const reason = ban.reason ? ` (${ban.reason})` : '';
  const country = describeIpShort(geoip, ban.ip);
  return `${ban.ip}${country ? ` ${country}` : ''}${reason} — ${formatExpiry(ban.expiresAt)} — banned on ${ban.serverAlias}`;
}

export function formatBansMessage(guidBans: Ban[], ipBans: BanIp[], geoip: CountryLookup = NO_COUNTRY_LOOKUP): string {
  if (guidBans.length === 0 && ipBans.length === 0) {
    return 'No active bans.';
  }

  const sections: string[] = ['Active bans (they apply on all servers):'];
  if (guidBans.length > 0) {
    sections.push(['GUID bans:', ...guidBans.map((ban) => formatGuidBan(ban))].join('\n'));
  }
  if (ipBans.length > 0) {
    sections.push(['IP bans:', ...ipBans.map((ban) => formatIpBan(ban, geoip))].join('\n'));
  }
  return sections.join('\n\n');
}

/** How many of the newest bans the short `/bans` lists before pointing at the attached file. */
const SUMMARY_NEWEST = 5;

type AnyBan = { kind: 'guid'; ban: Ban } | { kind: 'ip'; ban: BanIp };

function newestFirst(guidBans: Ban[], ipBans: BanIp[]): AnyBan[] {
  return [
    ...guidBans.map((ban): AnyBan => ({ kind: 'guid', ban })),
    ...ipBans.map((ban): AnyBan => ({ kind: 'ip', ban })),
  ].sort((a, b) => b.ban.bannedAt.getTime() - a.ban.bannedAt.getTime());
}

/** The short `/bans` for a long list: counts, then the newest few. */
export function formatBansSummary(guidBans: Ban[], ipBans: BanIp[], geoip: CountryLookup = NO_COUNTRY_LOOKUP): string {
  const all = newestFirst(guidBans, ipBans);
  const permanent = all.filter((entry) => entry.ban.expiresAt === null).length;
  const lines = [
    `Active bans: ${all.length} (they apply on all servers)`,
    `GUID ${guidBans.length} · IP ${ipBans.length} · permanent ${permanent} · temporary ${all.length - permanent}`,
    '',
    `Newest ${Math.min(SUMMARY_NEWEST, all.length)}:`,
    ...all
      .slice(0, SUMMARY_NEWEST)
      .map((entry) => (entry.kind === 'guid' ? formatGuidBan(entry.ban) : formatIpBan(entry.ban, geoip))),
    '',
    'Every ban, with reason and who issued it, in the attached file.',
  ];
  return lines.join('\n');
}

/** The attached `/bans` report: every active ban, newest first. */
export function formatBansReport(guidBans: Ban[], ipBans: BanIp[], geoip: CountryLookup, now: Date): string {
  const rows = newestFirst(guidBans, ipBans).map((entry) => {
    const { ban } = entry;
    return [
      entry.kind === 'guid' ? 'GUID' : 'IP',
      entry.kind === 'guid' ? (entry.ban.guid ?? 'unknown') : entry.ban.ip,
      entry.kind === 'guid' ? entry.ban.name : describeIpLong(geoip, entry.ban.ip),
      ban.reason,
      ban.bannedAt.toISOString().slice(0, 16).replace('T', ' '),
      ban.expiresAt ? ban.expiresAt.toISOString().slice(0, 16).replace('T', ' ') : 'permanent',
      ban.bannedBy,
      ban.serverAlias,
    ];
  });
  return reportDocument({
    title: 'Active bans',
    meta: [`GUID bans: ${guidBans.length}`, `IP bans: ${ipBans.length}`, 'Bans apply on every server this bot manages.'],
    body: markdownTable(['Type', 'GUID / IP', 'Name / location', 'Reason', 'Banned (UTC)', 'Expires (UTC)', 'By (Telegram ID)', 'Issued on'], rows),
    now,
    credits: ipBans.length > 0,
  });
}

export function buildBansReply(guidBans: Ban[], ipBans: BanIp[], geoip: CountryLookup, now: Date = new Date()): LongReply {
  return {
    full: formatBansMessage(guidBans, ipBans, geoip),
    summary: formatBansSummary(guidBans, ipBans, geoip),
    markdown: formatBansReport(guidBans, ipBans, geoip, now),
    fileName: reportFileName('bans', undefined, now),
  };
}

/**
 * `/bans` — lists currently active bans (both GUID-path `bans` and IP-path `ban_ips`,
 * docs/PLAN.md §7) so `/unban <guid-or-ip>` has something to target. Bans are global, so this
 * lists every server's, each with the server it was issued on; a `--server` flag is ignored.
 * A row leaves this list once its `expiresAt` passes (poller-driven) or `/unban` stamps its
 * `unbannedAt` — the row itself stays around as ban *history* (docs/PLAN.md §5 step 3).
 */
export async function bansCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const [guidBans, ipBans] = await Promise.all([deps.banStore.listActiveBans(), deps.banStore.listActiveIpBans()]);

  await replyWithReport(ctx, buildBansReply(guidBans, ipBans, deps.geoip));
}
