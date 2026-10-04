import { UdpQueryTimeoutError, type ServerStatus } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

export const ADDSERVER_USAGE =
  'Usage: /addserver <alias> <host:port> <rcon password>\n' +
  'Example: /addserver ctf2 185.158.113.146:28996 secret\n' +
  'Send it in a private chat with me — the message contains the RCON password, so I delete it right away.';

const ALIAS_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BAD_PASSWORD_PATTERN = /bad rcon ?password|no rcon ?password set/i;

interface AddServerArgs {
  alias: string;
  host: string;
  port: number;
  password: string;
}

/** Parses `<alias> <host:port> <password>`, or returns a reason it can't. */
export function parseAddServerArgs(text: string): AddServerArgs | string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length !== 3) {
    return ADDSERVER_USAGE;
  }
  const [alias, address, password] = tokens;
  if (!ALIAS_PATTERN.test(alias)) {
    return `Alias "${alias}" isn't valid — use up to 32 letters, digits, "-" or "_".`;
  }
  const colon = address.lastIndexOf(':');
  const host = colon > 0 ? address.slice(0, colon) : '';
  const port = Number(address.slice(colon + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return `"${address}" isn't a valid address — use host:port, e.g. 185.158.113.146:28960.`;
  }
  return { alias, host, port, password };
}

/**
 * Deletes the command message, since it contains an RCON password. Works in a private chat
 * (bots may delete incoming messages there); in a group it needs the bot to be an admin, so
 * failure is expected and only changes the warning we give.
 */
async function deleteCommandMessage(ctx: BotContext): Promise<boolean> {
  if (!ctx.deleteMessage) {
    return false;
  }
  try {
    await ctx.deleteMessage();
    return true;
  } catch {
    return false;
  }
}

function describeStatus(status: ServerStatus): string {
  const players = `${status.players.length} player${status.players.length === 1 ? '' : 's'}`;
  return status.mapName ? `${status.mapName}, ${players}` : players;
}

/**
 * `/addserver <alias> <host:port> <password>` — owner-only. Tests the address and password against
 * the live server before saving anything, then makes the server usable immediately (no restart).
 * Re-running it for an alias it added before updates that server (e.g. after a password change).
 */
export async function addServerCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const text = matchText(ctx);

  if (ctx.chat?.type && ctx.chat.type !== 'private') {
    const deleted = text ? await deleteCommandMessage(ctx) : false;
    await ctx.reply(
      '/addserver only works in a private chat with me, because the message contains the RCON password.' +
        (text
          ? deleted
            ? ' I deleted your message here, but others may have seen it — consider changing that password.'
            : ' I couldn\'t delete your message here — please delete it yourself, and consider changing that password.'
          : ''),
    );
    return;
  }
  if (text) {
    await deleteCommandMessage(ctx);
  }

  const args = parseAddServerArgs(text);
  if (typeof args === 'string') {
    await ctx.reply(args);
    return;
  }
  const { alias, host, port, password } = args;

  if (alias === deps.bootstrapServerAlias) {
    await ctx.reply(
      `"${alias}" comes from the bot's config file, so it can't be changed here. ` +
        'Pick another alias, or change it with install.sh --config on the bot\'s host.',
    );
    return;
  }

  await ctx.reply(`Checking ${host}:${port}… (can take up to ~10 seconds)`);
  const rcon = deps.createRconClient({ host, port, password });
  let status: ServerStatus;
  try {
    status = await rcon.status();
  } catch (error) {
    if (error instanceof UdpQueryTimeoutError) {
      await ctx.reply(
        `No answer from ${host}:${port}. Check the address and port, and that the server is running. Nothing was saved.`,
      );
      return;
    }
    throw error;
  }
  if (BAD_PASSWORD_PATTERN.test(status.raw)) {
    await ctx.reply(`${host}:${port} answered, but rejected the RCON password. Nothing was saved.`);
    return;
  }

  const existed = deps.rconClients.has(alias);
  await deps.adminStore.upsertServer({ alias, rconHost: host, rconPort: port, rconPassword: password });
  deps.rconClients.set(alias, rcon);

  // The first extra server would otherwise make every command without --server ambiguous; keep
  // them going where they went before, to the config-file server.
  let defaultNote = '';
  if (!(await deps.adminStore.getDefaultServer()) && deps.rconClients.has(deps.bootstrapServerAlias)) {
    await deps.adminStore.setDefaultServer(deps.bootstrapServerAlias);
    defaultNote = `\nCommands without --server still go to "${deps.bootstrapServerAlias}" — change that with /setdefault.`;
  }

  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: existed ? 'updateserver' : 'addserver',
    target: alias,
    serverAlias: alias,
    source: 'telegram_command',
    detailJson: { host, port },
  });
  await ctx.reply(
    `Server "${alias}" ${existed ? 'updated' : 'added'}: ${host}:${port} — ${describeStatus(status)}.\n` +
      `Use it with --server ${alias}, e.g. /status --server ${alias}.` +
      defaultNote,
  );
}
