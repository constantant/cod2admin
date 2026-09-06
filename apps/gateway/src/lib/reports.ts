import type { AdminRole, AdminStore } from '@cod2admin/admin-store';
import type { BanStore } from '@cod2admin/ban-store';
import type { ReportTrigger } from '@cod2admin/log-tailer';
import {
  buildReportCard,
  deriveReportActionContext,
  enrichReport,
  processReportTrigger,
  type CardSender,
  type ReportActionContext,
  type ReportAntiSpam,
  type ReportCard,
  type ReportCardAction,
  type ReportCardButton,
  type SessionLookup,
  type SessionSource,
} from '@cod2admin/report-pipeline';
import type { RconClient } from '@cod2admin/rcon-client';
import { Bot, InlineKeyboard } from 'grammy';
import { executeModerationAction, ModerationActionError } from './moderation-actions.js';

const CALLBACK_PREFIX = 'report:';
const ROLE_RANK: Record<AdminRole, number> = { moderator: 1, admin: 2, owner: 3 };

function encodeCallbackData(reportId: string, action: ReportCardAction): string {
  if (action.kind === 'select') {
    return `${CALLBACK_PREFIX}${reportId}:select:${action.candidateNum}`;
  }
  return `${CALLBACK_PREFIX}${reportId}:${action.kind}`;
}

interface DecodedCallback {
  reportId: string;
  action: ReportCardAction;
}

const SIMPLE_ACTION_KINDS = new Set(['kick', 'tempban', 'ban', 'ignore', 'more-info']);

/** The inverse of `encodeCallbackData` — returns null for anything not shaped like ours. */
export function decodeCallbackData(data: string): DecodedCallback | null {
  if (!data.startsWith(CALLBACK_PREFIX)) {
    return null;
  }
  const [reportId, kind, extra] = data.slice(CALLBACK_PREFIX.length).split(':');
  if (!reportId || !kind) {
    return null;
  }
  if (kind === 'select') {
    const candidateNum = Number.parseInt(extra, 10);
    return Number.isNaN(candidateNum) ? null : { reportId, action: { kind: 'select', candidateNum } };
  }
  if (SIMPLE_ACTION_KINDS.has(kind)) {
    return { reportId, action: { kind: kind as Exclude<ReportCardAction['kind'], 'select'> } };
  }
  return null;
}

function buildInlineKeyboard(buttons: ReportCardButton[][], reportId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  buttons.forEach((row, rowIndex) => {
    for (const button of row) {
      keyboard.text(button.label, encodeCallbackData(reportId, button.action));
    }
    if (rowIndex < buttons.length - 1) {
      keyboard.row();
    }
  });
  return keyboard;
}

export interface PendingReport {
  chatId: number;
  messageId: number;
  serverAlias: string;
  trigger: ReportTrigger;
  detailText?: string;
  context?: ReportActionContext;
}

/**
 * In-memory report-card state (docs/PLAN.md §5 step 6) — a short numeric id (embedded in
 * `callback_data`, well under Telegram's 64-byte limit) mapped to enough to edit the message
 * and act on it later. Not persisted — same restart caveat as `log-tailer`'s `SessionTracker`
 * and `ReportAntiSpam`: a gateway restart mid-flight just means old report buttons stop working.
 */
export class ReportRegistry {
  private readonly reports = new Map<string, PendingReport>();
  private nextId = 1;

  reserveId(): string {
    return String(this.nextId++);
  }

  set(id: string, report: PendingReport): void {
    this.reports.set(id, report);
  }

  get(id: string): PendingReport | undefined {
    return this.reports.get(id);
  }

  delete(id: string): void {
    this.reports.delete(id);
  }
}

/** `CardSender<string>` over grammy's `bot.api` — the report id doubles as the anti-spam `TCardRef`. */
export class GatewayCardSender implements CardSender<string> {
  constructor(
    private readonly bot: Bot,
    private readonly registry: ReportRegistry,
    private readonly serverAlias: string,
    private readonly trigger: ReportTrigger,
  ) {}

  async send(chatId: number, card: ReportCard): Promise<string> {
    const id = this.registry.reserveId();
    const keyboard = buildInlineKeyboard(card.buttons, id);
    const message = await this.bot.api.sendMessage(chatId, card.text, { reply_markup: keyboard });
    this.registry.set(id, {
      chatId,
      messageId: message.message_id,
      serverAlias: this.serverAlias,
      trigger: this.trigger,
      detailText: card.detailText,
    });
    return id;
  }

  async update(existing: string, card: ReportCard): Promise<void> {
    const entry = this.registry.get(existing);
    if (!entry) {
      return; // registry lost this (e.g. gateway restart) - nothing left to edit
    }
    entry.detailText = card.detailText;
    const keyboard = buildInlineKeyboard(card.buttons, existing);
    try {
      await this.bot.api.editMessageText(entry.chatId, entry.messageId, card.text, { reply_markup: keyboard });
    } catch (error) {
      // Telegram rejects a byte-identical edit (see status.ts's identical handling) - not an error.
      if (!(error instanceof Error) || !error.message.includes('message is not modified')) {
        throw error;
      }
    }
  }
}

export interface HandleReportTriggerOptions {
  bot: Bot;
  registry: ReportRegistry;
  antiSpam: ReportAntiSpam<string>;
  serverAlias: string;
  chatId: number;
  rcon: RconClient;
  sessions: SessionSource & SessionLookup;
  adminStore: AdminStore;
  banStore: BanStore;
}

/**
 * Entry point for a `GameLogTailer` `reportTrigger` event (docs/PLAN.md §5 steps 1-6). Not yet
 * wired to a live per-server tailer instance — see docs/PLAN.md's note on this — but this is the
 * function that wiring will call once it exists; it's fully functional and tested on its own.
 */
export async function handleReportTrigger(trigger: ReportTrigger, options: HandleReportTriggerOptions): Promise<void> {
  const cardSender = new GatewayCardSender(options.bot, options.registry, options.serverAlias, trigger);
  const outcome = await processReportTrigger(trigger, {
    rcon: options.rcon,
    sessions: options.sessions,
    adminStore: options.adminStore,
    banStore: options.banStore,
    antiSpam: options.antiSpam,
    cardSender,
    serverAlias: options.serverAlias,
    chatId: options.chatId,
  });
  if (outcome.kind !== 'cooldown') {
    const entry = options.registry.get(outcome.cardRef);
    if (entry) {
      entry.context = outcome.context;
    }
  }
}

/** Structural subset of grammy's callback-query `Context` (mirrors `BotContext`'s own approach). */
export interface ReportCallbackContext {
  from?: { id: number };
  admin?: { telegramId: number; role: AdminRole };
  callbackData: string;
  editMessageText(text: string, other?: unknown): Promise<unknown>;
  answerCallbackQuery(other?: { text?: string; show_alert?: boolean }): Promise<unknown>;
}

export interface ReportCallbackDeps {
  bot: Bot;
  registry: ReportRegistry;
  antiSpam: ReportAntiSpam<string>;
  rconClients: Map<string, RconClient>;
  adminStore: AdminStore;
  banStore: BanStore;
  /** Per-server session lookup for `select`'s re-enrichment — keyed like `rconClients`. */
  sessionsByServer: Map<string, SessionLookup>;
}

function requiresAdmin(action: ReportCardAction): boolean {
  return action.kind === 'ban';
}

/**
 * The button-press half of docs/PLAN.md §5 step 6: permission check → rcon/store action (via
 * `executeModerationAction`, shared with `/kick`/`/ban`/`/tempban`) → edit the message to the
 * resolved state → audit log (inside `executeModerationAction`) → clear anti-spam tracking for
 * `ignore`/a completed action, so a later report against the same target gets a fresh card.
 */
export async function reportActionCallback(ctx: ReportCallbackContext, deps: ReportCallbackDeps): Promise<void> {
  const decoded = decodeCallbackData(ctx.callbackData);
  if (!decoded) {
    await ctx.answerCallbackQuery({ text: 'Unrecognized action.' });
    return;
  }

  const entry = deps.registry.get(decoded.reportId);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: 'This report card has expired (gateway restarted).', show_alert: true });
    return;
  }

  const admin = ctx.admin;
  if (!admin) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' });
    return;
  }
  if (requiresAdmin(decoded.action) && ROLE_RANK[admin.role] < ROLE_RANK['admin']) {
    await ctx.answerCallbackQuery({ text: 'Admin role required for Ban.', show_alert: true });
    return;
  }

  const rcon = deps.rconClients.get(entry.serverAlias);
  if (!rcon) {
    await ctx.answerCallbackQuery({ text: 'Server no longer configured.' });
    return;
  }

  if (decoded.action.kind === 'more-info') {
    await ctx.answerCallbackQuery({ text: entry.detailText ?? 'No additional detail available.', show_alert: true });
    return;
  }

  if (decoded.action.kind === 'ignore') {
    await ctx.editMessageText(`${entry.trigger.targetName}'s report was ignored by admin ${admin.telegramId}.`);
    deps.antiSpam.resolve(entry.trigger.chat.num, entry.trigger.targetName);
    deps.registry.delete(decoded.reportId);
    await ctx.answerCallbackQuery();
    return;
  }

  if (decoded.action.kind === 'select') {
    const { candidateNum } = decoded.action;
    const { players } = await rcon.status();
    const candidate = players.find((player) => player.num === candidateNum);
    if (!candidate) {
      await ctx.answerCallbackQuery({ text: 'That player is no longer connected.', show_alert: true });
      return;
    }
    const sessions = deps.sessionsByServer.get(entry.serverAlias) ?? { getSession: () => undefined };
    const resolution = { kind: 'resolved' as const, player: candidate };
    const enriched = await enrichReport(resolution, entry.trigger, {
      sessions,
      adminStore: deps.adminStore,
      banStore: deps.banStore,
      serverAlias: entry.serverAlias,
    });
    const card = buildReportCard(enriched, entry.trigger);
    const cardSender = new GatewayCardSender(deps.bot, deps.registry, entry.serverAlias, entry.trigger);
    await cardSender.update(decoded.reportId, card);
    entry.context = deriveReportActionContext(resolution, entry.serverAlias);
    await ctx.answerCallbackQuery();
    return;
  }

  // kick / tempban / ban
  const context = entry.context;
  if (!context) {
    await ctx.answerCallbackQuery({ text: 'No resolved target to act on.', show_alert: true });
    return;
  }
  try {
    const result = await executeModerationAction(
      decoded.action.kind,
      { num: context.targetNum, name: context.targetName, guid: context.targetGuid, ip: context.targetIp },
      {
        serverAlias: entry.serverAlias,
        rcon,
        banStore: deps.banStore,
        adminStore: deps.adminStore,
        actorTelegramId: admin.telegramId,
        reason: entry.trigger.reason,
        source: 'telegram_button',
      },
    );
    await ctx.editMessageText(
      `${result.label} ${context.targetName} — action taken by admin ${admin.telegramId} at ${new Date().toISOString()}.`,
    );
    deps.antiSpam.resolve(entry.trigger.chat.num, entry.trigger.targetName);
    deps.registry.delete(decoded.reportId);
    await ctx.answerCallbackQuery();
  } catch (error) {
    if (error instanceof ModerationActionError) {
      await ctx.answerCallbackQuery({ text: error.message, show_alert: true });
      return;
    }
    throw error;
  }
}
