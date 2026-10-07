import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { normalizeExempt, VPN_KICK_SETTING_KEY, type VpnKickSettings } from '../vpn-kick.js';
import { NO_VPN_LOOKUP } from '../vpn-ranges.js';

export const VPNKICK_USAGE = [
  '/vpnkick — show whether VPN players are kicked',
  '/vpnkick on | off',
  '/vpnkick allow <GUID or name> — never kick this player for a VPN',
  '/vpnkick unallow <GUID or name>',
].join('\n');

function formatStatus(settings: VpnKickSettings): string {
  const lines = [
    settings.enabled
      ? 'VPN kick is ON: players marked 🛡 (VPN, proxy, Tor, hosting or a /vpnnets network) are kicked on sight, on every server, with a message in the game chat. Nobody is banned.'
      : 'VPN kick is OFF: players marked 🛡 are only shown as such in /players.',
  ];
  lines.push(
    settings.exempt.length > 0 ? `Never kicked: ${settings.exempt.join(', ')}` : 'Nobody is exempt.',
    '',
    VPNKICK_USAGE,
  );
  return lines.join('\n');
}

async function save(ctx: BotContext, deps: GatewayDeps, settings: VpnKickSettings, detail: unknown): Promise<void> {
  await deps.adminStore.setSetting(VPN_KICK_SETTING_KEY, settings);
  deps.vpnKick.setSettings(settings);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'vpnkick',
    target: null,
    source: 'telegram_command',
    detailJson: detail,
  });
}

/**
 * `/vpnkick [on|off|allow|unallow]` — kick players the 🛡 mark flags (vpn-kick.ts). Saved in the
 * database, applied at once; the current state lives in `deps.vpnKick`.
 */
export async function vpnKickCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const text = matchText(ctx);
  const [subcommand = ''] = text.split(/\s+/);
  const arg = text.slice(subcommand.length).trim();
  const settings = deps.vpnKick.settings;
  const offNote =
    deps.vpn === NO_VPN_LOOKUP ? '\n\nNote: VPN flags are turned off on this bot (VPN_FLAG_ENABLED=false), so nobody is flagged.' : '';

  switch (subcommand.toLowerCase()) {
    case '': {
      await ctx.reply(formatStatus(settings) + offNote);
      return;
    }

    case 'on':
    case 'off': {
      const next = { ...settings, enabled: subcommand.toLowerCase() === 'on' };
      await save(ctx, deps, next, { enabled: next.enabled });
      await ctx.reply(formatStatus(next).split('\n')[0]! + offNote);
      return;
    }

    case 'allow':
    case 'unallow': {
      const entry = arg ? normalizeExempt(arg) : '';
      if (!entry) {
        await ctx.reply(`Usage: /vpnkick ${subcommand.toLowerCase()} <GUID or name>`);
        return;
      }
      const has = settings.exempt.includes(entry);
      if (subcommand.toLowerCase() === 'allow') {
        if (has) {
          await ctx.reply(`${entry} is already exempt.`);
          return;
        }
        await save(ctx, deps, { ...settings, exempt: [...settings.exempt, entry] }, { allow: entry });
        await ctx.reply(`${entry} will never be kicked for a VPN.${/^\d+$/.test(entry) ? '' : ' (By name — anyone can take a name; a GUID is safer.)'}`);
        return;
      }
      if (!has) {
        await ctx.reply(`${entry} isn't exempt — see /vpnkick for the list.`);
        return;
      }
      await save(ctx, deps, { ...settings, exempt: settings.exempt.filter((existing) => existing !== entry) }, { unallow: entry });
      await ctx.reply(`${entry} is no longer exempt.`);
      return;
    }

    default:
      await ctx.reply(VPNKICK_USAGE);
  }
}
