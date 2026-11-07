import { InlineKeyboard } from 'grammy';
import type { ActingAdmin, BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { grantablePermissions, parseScope } from '../../mcp/scope.js';

const NOT_HERE =
  'Replacing the bot, its Telegram route, server passwords and the staff list stay in Telegram.';

function privateChat(ctx: BotContext): boolean {
  return ctx.chat?.type === 'private' || ctx.chat === undefined;
}

/** `/mcp` lists this person's AI connections. `/mcp revoke <id>` and `/mcp revoke all` end them. */
export async function mcpCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  if (!deps.mcp) {
    await ctx.reply(
      "Connecting an AI needs the server manager's public address. Set MINIAPP_URL and MINIAPP_PORT.",
    );
    return;
  }
  if (!privateChat(ctx)) {
    await ctx.reply('Open a private chat with the bot to manage AI connections.');
    return;
  }
  const [verb, id] = String(ctx.match ?? '').trim().split(/\s+/);
  if (verb === 'revoke' && id === 'all') {
    const grants = await deps.mcp.sessions.list(ctx.admin!.telegramId);
    await Promise.all(
      grants.map((grant) => deps.mcp!.sessions.revokeGrant(ctx.admin!.telegramId, grant.id)),
    );
    await ctx.reply(grants.length ? `Ended ${grants.length} connection(s).` : 'No connections to end.');
    return;
  }
  if (verb === 'revoke' && id) {
    const revoked = await deps.mcp.sessions.revokeGrant(ctx.admin!.telegramId, id);
    await ctx.reply(revoked ? 'Ended that connection.' : 'No connection with that id.');
    return;
  }
  const grants = await deps.mcp.sessions.list(ctx.admin!.telegramId);
  const lines = [
    `AI connections use ${deps.mcp.origin}/mcp.`,
    'Add that address in the app. Leave the browser page it opens where it is.',
    'Approve in Telegram opens beside that page. After you choose, go back to the page. It returns you to the app.',
    'A read-only connection can read the game chat. Allow say on it to let the AI speak. A connection that can kick or ban does not receive the chat.',
    'End a connection with /mcp revoke <id>.',
    '',
  ];
  if (grants.length === 0) {
    lines.push('Nothing is connected.');
  } else {
    for (const grant of grants) {
      lines.push(
        `${grant.clientName} at ${grant.redirectHost}`,
        `id ${grant.id}`,
        grant.permissions.length ? grant.permissions.join(', ') : 'read only',
        '',
      );
    }
  }
  await ctx.reply(lines.join('\n').trim());
}

/**
 * The secret after `/start mcp_`. Base64url can itself contain `_`, so this slices the prefix
 * instead of splitting on it.
 */
export function approveTokenFromStart(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith('mcp_') || trimmed.length === 'mcp_'.length) {
    return undefined;
  }
  return trimmed.slice('mcp_'.length);
}

/** `/start mcp_<token>` — show the approval. Opening the link does not approve it. */
export async function mcpStart(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const token = approveTokenFromStart(String(ctx.match ?? ''));
  if (token === undefined) {
    await ctx.reply('Use /help to see the commands.');
    return;
  }
  if (!deps.mcp) {
    await ctx.reply('AI connections are not set up on this bot.');
    return;
  }
  if (!privateChat(ctx)) {
    await ctx.reply('Open a private chat with the bot to connect an AI.');
    return;
  }
  const admin = await deps.adminStore.getAdmin(ctx.from?.id ?? NaN);
  if (!admin) {
    await ctx.reply('Only a staff account can connect an AI.');
    return;
  }
  const opened = await deps.mcp.sessions.open(token, admin.telegramId);
  if (opened === 'unknown' || opened === 'expired') {
    await ctx.reply('This connection request has expired. Start it again from the app.');
    return;
  }
  if (opened === 'taken') {
    await ctx.reply('Someone else already opened this connection request.');
    return;
  }
  if (opened === 'decided') {
    await ctx.reply('This connection request was already answered.');
    return;
  }
  const requested = parseScope(opened.scope);
  const asked = typeof requested === 'string' ? [] : requested.permissions;
  const giving = grantablePermissions(admin, asked);
  const keyboard = new InlineKeyboard();
  if (giving.length > 0) {
    const label = `Allow ${giving.join(', ')}`;
    keyboard.text(label.length <= 60 ? label : 'Allow what it asked', `mcp:allow:${opened.publicId}`).row();
  }
  keyboard.text('Allow read only', `mcp:read:${opened.publicId}`).row();
  keyboard.text('Deny', `mcp:deny:${opened.publicId}`);
  const askedLine = asked.length ? asked.join(', ') : 'read only';
  const giveLine = giving.length ? giving.join(', ') : 'nothing beyond reading';
  await ctx.reply(
    [
      `${opened.clientName} at ${opened.redirectHost} wants to connect as you.`,
      '',
      `It asked for: ${askedLine}`,
      `You can give it: ${giveLine}`,
      '',
      'Allowing it lets that app act as you until you run /mcp revoke.',
      'Read only lets it see the server and change nothing.',
      'Leave the browser page open. After you choose, go back to it. It returns you to the app.',
      NOT_HERE,
      '',
      `Continue only if you just started this, and the page address matches ${opened.redirectHost}.`,
    ].join('\n'),
    { reply_markup: keyboard },
  );
}

export interface McpDecisionContext {
  fromId: number;
  admin: ActingAdmin;
  data: string;
  /** False when the button was pressed in a group. */
  privateChat: boolean;
  answer(text: string): Promise<unknown>;
  edit(text: string): Promise<unknown>;
}

/** The confirm / deny buttons under the `/start` message. */
export async function mcpDecision(
  ctx: McpDecisionContext,
  deps: GatewayDeps,
): Promise<void> {
  if (!ctx.privateChat) {
    await ctx.answer('Open a private chat with the bot to connect an AI.');
    return;
  }
  const match = /^mcp:(allow|read|deny):([0-9a-f]{32})$/.exec(ctx.data);
  if (!match || !deps.mcp) {
    await ctx.answer('That confirmation is no longer valid.');
    return;
  }
  const choice = match[1] as 'allow' | 'read' | 'deny';
  const publicId = match[2]!;
  const admin = await deps.adminStore.getAdmin(ctx.fromId);
  if (!admin || admin.telegramId !== ctx.admin.telegramId) {
    await ctx.answer('Only a staff account can connect an AI.');
    return;
  }
  const row = await deps.mcp.sessions.describe(publicId);
  if (!row || row.telegramId !== ctx.fromId) {
    await ctx.answer('This request is not yours, or it expired.');
    return;
  }
  const requested = parseScope(row.scope);
  const asked = typeof requested === 'string' ? [] : requested.permissions;
  const giving = choice === 'allow' ? grantablePermissions(admin, asked) : [];
  const decision = choice === 'allow' && giving.length === 0 ? 'read' : choice;
  const saved = await deps.mcp.sessions.decide(publicId, ctx.fromId, decision, giving);
  if (!saved) {
    await ctx.answer('This request was already answered.');
    return;
  }
  const text =
    decision === 'deny'
      ? 'Denied. The app was not connected. Go back to the browser page.'
      : decision === 'read'
        ? 'Connected, read only. Go back to the browser page. End it with /mcp revoke.'
        : `Connected with ${giving.join(', ')}. Go back to the browser page. End it with /mcp revoke.`;
  await ctx.answer(decision === 'deny' ? 'Denied.' : 'Saved. Go back to the browser page.');
  await ctx.edit(text);
}
