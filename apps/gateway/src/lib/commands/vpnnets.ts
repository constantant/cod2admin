import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { NO_VPN_LOOKUP, parseVpnNetworks, VPN_NETWORKS_SETTING_KEY, type VpnNetwork } from '../vpn-ranges.js';

export const VPNNETS_USAGE = [
  '/vpnnets — provider networks shown as 🛡 VPN',
  "/vpnnets add <player IP or ASN> — e.g. a VPN player's IP from /players, or AS202226",
  '/vpnnets remove <ASN>',
].join('\n');

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** `AS202226`, `as202226` or `202226` → 202226. */
function parseAsn(text: string): number | undefined {
  const match = /^(?:AS)?(\d{1,10})$/i.exec(text);
  const asn = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(asn) && asn > 0 && asn <= 0xffffffff ? asn : undefined;
}

function formatNetwork(network: VpnNetwork): string {
  return network.name ? `AS${network.asn} — ${network.name}` : `AS${network.asn}`;
}

function formatList(networks: VpnNetwork[]): string {
  const lines =
    networks.length === 0
      ? ['No provider networks are marked as VPN.']
      : ['Provider networks shown as 🛡 VPN:', ...networks.map((network) => `• ${formatNetwork(network)}`)];
  return [...lines, '', VPNNETS_USAGE].join('\n');
}

async function save(ctx: BotContext, deps: GatewayDeps, networks: VpnNetwork[], detail: unknown): Promise<void> {
  await deps.adminStore.setSetting(VPN_NETWORKS_SETTING_KEY, networks);
  deps.vpn.setNetworks(networks.map((network) => network.asn));
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'vpnnets',
    target: null,
    source: 'telegram_command',
    detailJson: detail,
  });
}

/**
 * `/vpnnets [add|remove]` — whole provider networks (ASNs) that `/players` and report cards mark as
 * VPN, for VPNs the downloaded lists miss (vpn-ranges.ts). Saved in the database, applied at once.
 */
export async function vpnNetsCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const [subcommand = '', arg = ''] = matchText(ctx).split(/\s+/).filter(Boolean);
  const networks = parseVpnNetworks(await deps.adminStore.getSetting(VPN_NETWORKS_SETTING_KEY));
  const offNote = deps.vpn === NO_VPN_LOOKUP ? '\n\nNote: VPN flags are turned off on this bot (VPN_FLAG_ENABLED=false).' : '';

  switch (subcommand.toLowerCase()) {
    case '': {
      await ctx.reply(formatList(networks) + offNote);
      return;
    }

    case 'add': {
      let network: VpnNetwork | undefined;
      if (IPV4_PATTERN.test(arg)) {
        const asn = deps.provider.asn(arg);
        if (asn === undefined) {
          await ctx.reply(`Couldn't find the provider network for ${arg}. Add it by ASN instead, e.g. /vpnnets add AS202226.`);
          return;
        }
        const name = deps.provider.lookup(arg);
        network = name ? { asn, name } : { asn };
      } else {
        const asn = parseAsn(arg);
        network = asn === undefined ? undefined : { asn };
      }
      if (!network) {
        await ctx.reply(`Usage: ${VPNNETS_USAGE.split('\n')[1]}`);
        return;
      }
      const added = network;
      if (networks.some((existing) => existing.asn === added.asn)) {
        await ctx.reply(`AS${added.asn} is already marked as VPN.`);
        return;
      }
      await save(ctx, deps, [...networks, added], { add: added.asn });
      await ctx.reply(`Players on ${formatNetwork(added)} are now shown as 🛡 VPN.${offNote}`);
      return;
    }

    case 'remove': {
      const asn = parseAsn(arg);
      if (asn === undefined || !networks.some((network) => network.asn === asn)) {
        await ctx.reply('Usage: /vpnnets remove <ASN> — see /vpnnets for the list.');
        return;
      }
      await save(
        ctx,
        deps,
        networks.filter((network) => network.asn !== asn),
        { remove: asn },
      );
      await ctx.reply(`AS${asn} is no longer marked as VPN.`);
      return;
    }

    default:
      await ctx.reply(VPNNETS_USAGE);
  }
}
