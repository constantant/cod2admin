import type { AdminStore } from '@cod2admin/admin-store';
import type { BanStore, Mute } from '@cod2admin/ban-store';
import { detectReportTrigger, type ChatEvent } from '@cod2admin/log-tailer';
import type { RconClient } from '@cod2admin/rcon-client';
import {
  DEFAULT_CHAT_TEMPLATES,
  renderChatTemplate,
  type ChatTemplates,
} from './chat-templates.js';
import { displayName } from './commands/players.js';
import { sanitizeRconArg } from './sanitize.js';

/** The built-in mute warning. A stored template replaces it. */
export const MUTE_WARNING = DEFAULT_CHAT_TEMPLATES.mute_warn;

/** GUID 0 is shared by most players (docs/PLAN.md §2.4), so it identifies nobody. */
export function usableGuid(guid: string | null | undefined): string | null {
  return guid && guid !== '0' ? guid : null;
}

/**
 * The mute covering this player: by GUID or IP, like bans, so a new name doesn't escape it. The name
 * only counts for a mute recorded with neither, when the server reported no GUID or IP at all.
 */
export function findMute(
  mutes: readonly Mute[],
  player: { name: string; guid?: string | null; ip?: string | null },
): Mute | undefined {
  const guid = usableGuid(player.guid);
  return mutes.find(
    (mute) =>
      (mute.guid !== null && mute.guid === guid) ||
      (mute.ip !== null && mute.ip === player.ip) ||
      (mute.guid === null && mute.ip === null && mute.name === player.name),
  );
}

export interface MuteEnforcerOptions {
  serverAlias: string;
  /** Looked up per message: `/removeserver` can drop the client while the bot runs. */
  rcon(): RconClient | undefined;
  banStore: Pick<BanStore, 'listActiveMutes'>;
  adminStore: Pick<AdminStore, 'recordAuditLog'>;
  /** Absent: the built-in warning. */
  chatTemplates?: ChatTemplates;
}

/**
 * Enforces chat mutes on one server (issue #7). The game has no per-player mute and logs a message
 * only after everyone has seen it, so this can't hide anything: it punishes instead. The first
 * message under a mute earns a private warning, every later one a kick. Warnings are kept in memory,
 * so a restart of the bot gives one more.
 */
export class MuteEnforcer {
  private readonly warned = new Set<number>();

  constructor(private readonly options: MuteEnforcerOptions) {}

  async handle(chat: ChatEvent): Promise<void> {
    // A muted player can still report someone. Quick messages (the voice-command menu) are logged
    // as chat, e.g. `^TQUICKMESSAGE_BRITISH_TAUNT2B`, but nobody typed them: fixed lines, not abuse.
    const text = chat.message.replace(/^[\x00-\x1f]+/, '').trim();
    if (
      !text ||
      text.startsWith('QUICKMESSAGE_') ||
      detectReportTrigger(chat)
    ) {
      return;
    }
    const mutes = await this.options.banStore.listActiveMutes();
    const rcon = this.options.rcon();
    if (mutes.length === 0 || !rcon) {
      return;
    }

    // The log gives no IP, and most players have GUID 0, so ask who's in that slot.
    const { players } = await rcon.status();
    const player = players.find((candidate) => candidate.num === chat.num);
    const mute = player && findMute(mutes, player);
    if (!player || !mute) {
      return;
    }

    if (!this.warned.has(mute.id)) {
      this.warned.add(mute.id);
      const warning = renderChatTemplate(
        this.options.chatTemplates?.get('mute_warn') ?? MUTE_WARNING,
        { name: displayName(player) },
      );
      if (warning) {
        await rcon.tell(player.num, warning);
      }
      return;
    }
    await rcon.kick(player.num, sanitizeRconArg(player.name));
    await this.options.adminStore.recordAuditLog({
      actorTelegramId: 0,
      action: 'mute_kick',
      target: player.name,
      serverAlias: this.options.serverAlias,
      source: 'auto',
      detailJson: { muteId: mute.id, message: chat.message },
    });
  }
}
