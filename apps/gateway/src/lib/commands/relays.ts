import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import {
  describeRoute,
  DIRECT_TELEGRAM_ROOT,
  normalizeRelayUrl,
  parseRouteSettings,
  ROUTES_SETTING_KEY,
  routesFrom,
  type TelegramRouteSettings,
} from '../telegram-routes.js';

export const RELAYS_USAGE = [
  '/relays — show how the bot reaches Telegram',
  '/relays test — check every route now',
  '/relays add <https://url> — add a relay (checked before it\'s saved)',
  '/relays remove <number or url> — remove a relay',
  '/relays direct on|off — try api.telegram.org itself first, or not',
  '/relays reset — back to the defaults',
].join('\n');

async function loadSettings(deps: GatewayDeps): Promise<{ settings: TelegramRouteSettings; changed: boolean }> {
  const stored = parseRouteSettings(await deps.adminStore.getSetting(ROUTES_SETTING_KEY));
  return stored ? { settings: stored, changed: true } : { settings: deps.telegramRoutes.defaults, changed: false };
}

async function saveSettings(ctx: BotContext, deps: GatewayDeps, settings: TelegramRouteSettings, detail: unknown): Promise<void> {
  await deps.adminStore.setSetting(ROUTES_SETTING_KEY, settings);
  deps.telegramRoutes.router.setRoutes(routesFrom(settings));
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'relays',
    target: null,
    source: 'telegram_command',
    detailJson: detail,
  });
}

function formatRoutes(deps: GatewayDeps, settings: TelegramRouteSettings, changed: boolean): string {
  const { router } = deps.telegramRoutes;
  const lines = [`Connected to Telegram via: ${describeRoute(router.current)}`, '', 'Routes, tried in this order:'];
  routesFrom(settings).forEach((root, i) => {
    lines.push(`${i + 1}. ${describeRoute(root)}${root === router.current ? '  ← in use' : ''}`);
  });
  lines.push('', changed ? 'Changed with /relays (/relays reset goes back to the defaults).' : 'These are the defaults.');
  lines.push('', RELAYS_USAGE);
  return lines.join('\n');
}

/**
 * `/relays [test|add|remove|direct|reset]` — owner-only management of how the bot reaches Telegram
 * (telegram-routes.ts). Changes are saved in the database and applied immediately, no restart.
 */
export async function relaysCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const [subcommand = '', ...args] = matchText(ctx).split(/\s+/).filter(Boolean);
  const { settings, changed } = await loadSettings(deps);

  switch (subcommand.toLowerCase()) {
    case '': {
      await ctx.reply(formatRoutes(deps, settings, changed));
      return;
    }

    case 'test': {
      const routes = routesFrom(settings);
      const results = await Promise.all(routes.map((root) => deps.telegramRoutes.probe(root)));
      const lines = routes.map((root, i) => {
        const result = results[i];
        return `${i + 1}. ${describeRoute(root)} — ${result.ok ? `✅ ${result.ms} ms` : `❌ ${result.error}`}`;
      });
      await ctx.reply(['Route check:', ...lines].join('\n'));
      return;
    }

    case 'add': {
      const url = args[0] ? normalizeRelayUrl(args[0]) : undefined;
      if (!url) {
        await ctx.reply('Usage: /relays add <https://url>, e.g. /relays add https://my-relay.deno.dev');
        return;
      }
      if (url === DIRECT_TELEGRAM_ROOT || settings.relays.includes(url)) {
        await ctx.reply(`${url} is already in the list.`);
        return;
      }
      const result = await deps.telegramRoutes.probe(url);
      if (!result.ok) {
        await ctx.reply(`Couldn't reach Telegram through ${url} (${result.error}). Nothing was changed.`);
        return;
      }
      const next = { ...settings, relays: [...settings.relays, url] };
      await saveSettings(ctx, deps, next, { add: url });
      await ctx.reply(`Added ${url} (reached Telegram in ${result.ms} ms).`);
      return;
    }

    case 'remove': {
      const routes = routesFrom(settings);
      const arg = args[0] ?? '';
      const byNumber = /^\d+$/.test(arg) ? routes[Number(arg) - 1] : undefined;
      const target = byNumber ?? normalizeRelayUrl(arg);
      if (!target || !routes.includes(target)) {
        await ctx.reply('Usage: /relays remove <number or url> — see /relays for the numbers.');
        return;
      }
      if (target === DIRECT_TELEGRAM_ROOT) {
        await ctx.reply('That\'s direct access — turn it off with /relays direct off.');
        return;
      }
      const next = { ...settings, relays: settings.relays.filter((relay) => relay !== target) };
      if (routesFrom(next).length === 0) {
        await ctx.reply('That\'s the only route left — add another one first.');
        return;
      }
      await saveSettings(ctx, deps, next, { remove: target });
      await ctx.reply(`Removed ${target}.`);
      return;
    }

    case 'direct': {
      const mode = args[0]?.toLowerCase();
      if (mode !== 'on' && mode !== 'off') {
        await ctx.reply('Usage: /relays direct on|off');
        return;
      }
      const next = { ...settings, direct: mode === 'on' };
      if (routesFrom(next).length === 0) {
        await ctx.reply('There are no relays — add one before turning direct access off.');
        return;
      }
      await saveSettings(ctx, deps, next, { direct: next.direct });
      await ctx.reply(`Direct access to api.telegram.org is now ${mode}.`);
      return;
    }

    case 'reset': {
      await deps.adminStore.deleteSetting(ROUTES_SETTING_KEY);
      deps.telegramRoutes.router.setRoutes(routesFrom(deps.telegramRoutes.defaults));
      await deps.adminStore.recordAuditLog({
        actorTelegramId: ctx.admin!.telegramId,
        action: 'relays',
        target: null,
        source: 'telegram_command',
        detailJson: { reset: true },
      });
      await ctx.reply(formatRoutes(deps, deps.telegramRoutes.defaults, false));
      return;
    }

    default:
      await ctx.reply(RELAYS_USAGE);
  }
}
