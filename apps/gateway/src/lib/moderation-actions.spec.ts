import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_TEMPLATES } from './chat-templates.js';
import { createFakeDeps } from './testing/fake-deps.js';
import {
  ModerationActionError,
  executeModerationAction,
  type ModerationTarget,
} from './moderation-actions.js';

function target(overrides: Partial<ModerationTarget> = {}): ModerationTarget {
  return { num: 2, name: 'Cheatr123', ...overrides };
}

function baseOptions() {
  const { deps, rcon, banStore, adminStore } = createFakeDeps();
  return {
    rcon,
    banStore,
    adminStore,
    deps,
    options: {
      serverAlias: 'default',
      rcon: deps.rconClients.get('default')!,
      banStore: deps.banStore,
      adminStore: deps.adminStore,
      actorTelegramId: 1,
      source: 'telegram_command' as const,
      chatTemplates: deps.chatTemplates,
    },
  };
}

describe('executeModerationAction', () => {
  it('kicks: rcon.kick, broadcast, audit log — no ban-store involvement', async () => {
    const { rcon, banStore, adminStore, options } = baseOptions();

    const result = await executeModerationAction('kick', target(), options);

    expect(result).toEqual({ label: 'Kicked', ipFallback: false });
    expect(rcon.kick).toHaveBeenCalledWith(2, 'Cheatr123');
    expect(rcon.say).toHaveBeenCalledWith('Cheatr123 was kicked by an admin');
    expect(banStore.recordBan).not.toHaveBeenCalled();
    expect(banStore.recordIpBan).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'kick',
        target: 'Cheatr123',
        serverAlias: 'default',
        source: 'telegram_command',
      }),
    );
  });

  it('kicks without a game-chat line when that template is empty', async () => {
    const { rcon, options } = baseOptions();
    options.chatTemplates.setAll({ ...DEFAULT_CHAT_TEMPLATES, kick: '' });

    await executeModerationAction('kick', target(), options);

    expect(rcon.kick).toHaveBeenCalledWith(2, 'Cheatr123');
    expect(rcon.say).not.toHaveBeenCalled();
  });

  it('puts the reason and the length into a temp-ban line that asks for them', async () => {
    const { rcon, options } = baseOptions();
    options.chatTemplates.setAll({
      ...DEFAULT_CHAT_TEMPLATES,
      tempban: '{name} for {minutes}m: {reason}',
    });

    await executeModerationAction('tempban', target({ guid: '123' }), {
      ...options,
      reason: 'aimbot',
      durationMs: 30 * 60_000,
    });

    expect(rcon.say).toHaveBeenCalledWith('Cheatr123 for 30m: aimbot');
  });

  it('bans via the GUID path when a usable GUID is available', async () => {
    const { rcon, banStore, options } = baseOptions();

    const result = await executeModerationAction(
      'ban',
      target({ guid: 'realguid' }),
      options,
    );

    expect(result).toEqual({
      label: 'Banned',
      ipFallback: false,
      durationMs: undefined,
    });
    expect(rcon.banClient).toHaveBeenCalledWith(2);
    expect(rcon.kick).not.toHaveBeenCalled();
    expect(banStore.recordBan).toHaveBeenCalledWith(
      expect.objectContaining({
        serverAlias: 'default',
        name: 'Cheatr123',
        guid: 'realguid',
        expiresAt: null,
      }),
    );
    expect(rcon.say).toHaveBeenCalledWith('Cheatr123 was banned by an admin');
  });

  it('also kicks when banClient replies, since then it may not have dropped the player', async () => {
    const { rcon, banStore, options } = baseOptions();
    rcon.banClient.mockResolvedValue('This GUID (123) is already banned\n');

    await executeModerationAction('ban', target({ guid: '123' }), options);

    expect(rcon.kick).toHaveBeenCalledWith(2, 'Cheatr123');
    expect(banStore.recordBan).toHaveBeenCalledWith(
      expect.objectContaining({ guid: '123' }),
    );
  });

  it('keeps a GUID ban out of ban.txt when unbanUser could never remove it again (docs/PLAN.md §2.4)', async () => {
    const { rcon, banStore, options } = baseOptions();

    await executeModerationAction(
      'ban',
      target({ name: 'Вика', guid: 'realguid' }),
      options,
    );

    expect(rcon.banClient).not.toHaveBeenCalled();
    expect(rcon.kick).toHaveBeenCalledWith(2, 'Вика');
    expect(banStore.recordBan).toHaveBeenCalledWith(
      expect.objectContaining({ guid: 'realguid', expiresAt: null }),
    );
  });

  it('temp-bans via the GUID path with expiresAt set, kicking rather than writing ban.txt', async () => {
    const { rcon, banStore, options } = baseOptions();

    const result = await executeModerationAction(
      'tempban',
      target({ guid: 'realguid' }),
      { ...options, durationMs: 60_000 },
    );

    expect(result.label).toBe('Temp-banned');
    expect(result.durationMs).toBe(60_000);
    expect(rcon.banClient).not.toHaveBeenCalled();
    expect(rcon.kick).toHaveBeenCalledWith(2, 'Cheatr123');
    const call = banStore.recordBan.mock.calls[0][0];
    expect(call.expiresAt).toBeInstanceOf(Date);
    expect((call.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('falls back to an IP ban when the GUID is "0" (docs/PLAN.md §2.4)', async () => {
    const { rcon, banStore, options } = baseOptions();

    const result = await executeModerationAction(
      'ban',
      target({ guid: '0', ip: '1.2.3.4' }),
      options,
    );

    expect(result).toEqual({
      label: 'IP-banned (GUID unavailable)',
      ipFallback: true,
      durationMs: undefined,
    });
    expect(rcon.banClient).not.toHaveBeenCalled();
    expect(rcon.kick).toHaveBeenCalledWith(2, 'Cheatr123');
    expect(banStore.recordIpBan).toHaveBeenCalledWith(
      expect.objectContaining({
        serverAlias: 'default',
        ip: '1.2.3.4',
        name: 'Cheatr123',
        expiresAt: null,
      }),
    );
    // The in-game broadcast stays a plain player-facing verb even on the fallback path — no
    // "GUID unavailable" jargon in a chat announcement; that detail is for the admin-facing label only.
    expect(rcon.say).toHaveBeenCalledWith('Cheatr123 was banned by an admin');
  });

  it('falls back to an IP ban when the GUID is entirely absent', async () => {
    const { rcon, options } = baseOptions();

    await executeModerationAction(
      'ban',
      target({ guid: undefined, ip: '1.2.3.4' }),
      options,
    );

    expect(rcon.kick).toHaveBeenCalledWith(2, 'Cheatr123');
  });

  it('temp-bans via the IP fallback with expiresAt set', async () => {
    const { banStore, options } = baseOptions();

    const result = await executeModerationAction(
      'tempban',
      target({ guid: '0', ip: '1.2.3.4' }),
      { ...options, durationMs: 60_000 },
    );

    expect(result.label).toBe('IP temp-banned (GUID unavailable)');
    const call = banStore.recordIpBan.mock.calls[0][0];
    expect(call.expiresAt).toBeInstanceOf(Date);
  });

  it('throws when there is neither a usable GUID nor an IP', async () => {
    const { options } = baseOptions();

    await expect(
      executeModerationAction(
        'ban',
        target({ guid: '0', ip: undefined }),
        options,
      ),
    ).rejects.toThrow(ModerationActionError);
  });

  it('sanitizes the reason before it reaches rcon/store, and includes it in the audit log', async () => {
    const { banStore, adminStore, options } = baseOptions();

    await executeModerationAction('ban', target({ guid: 'realguid' }), {
      ...options,
      reason: 'cheating; banUser 0',
    });

    expect(banStore.recordBan).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'cheating banUser 0' }),
    );
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'cheating banUser 0' }),
    );
  });

  it('watch kick uses slotOnly, the watch line, and audit action watch_kick', async () => {
    const { rcon, banStore, adminStore, options } = baseOptions();

    const result = await executeModerationAction('kick', target(), {
      ...options,
      actorTelegramId: 0,
      source: 'auto',
      auditAction: 'watch_kick',
      chatTemplateId: 'watch_kick',
      slotOnly: true,
      detailJson: { watch: true, lifeScore: 8 },
      beforeAudit: async () => ({ evidenceId: 'ev-1' }),
    });

    expect(result).toEqual({ label: 'Kicked', ipFallback: false });
    expect(rcon.kick).toHaveBeenCalledWith(2, undefined, { slotOnly: true });
    expect(rcon.say).toHaveBeenCalledWith('Cheatr123 was kicked');
    expect(banStore.recordBan).not.toHaveBeenCalled();
    expect(banStore.recordIpBan).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'watch_kick',
        actorTelegramId: 0,
        source: 'auto',
        detailJson: { watch: true, lifeScore: 8, evidenceId: 'ev-1' },
      }),
    );
  });

  it('does not say or audit when slotOnly clientkick is an unknown command', async () => {
    const { rcon, adminStore, options } = baseOptions();
    rcon.kick.mockResolvedValue('Unknown command "clientkick"');

    const result = await executeModerationAction('kick', target(), {
      ...options,
      slotOnly: true,
      auditAction: 'watch_kick',
      chatTemplateId: 'watch_kick',
      beforeAudit: async () => ({ evidenceId: 'ev-1' }),
    });

    expect(result.unknownCommand).toBe(true);
    expect(rcon.kick).toHaveBeenCalledTimes(1);
    expect(rcon.kick).toHaveBeenCalledWith(2, undefined, { slotOnly: true });
    expect(rcon.say).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).not.toHaveBeenCalled();
  });

  it('tags the audit source as given (telegram_button for report-card actions)', async () => {
    const { adminStore, options } = baseOptions();

    await executeModerationAction('kick', target(), {
      ...options,
      source: 'telegram_button',
    });

    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'telegram_button' }),
    );
  });
});
