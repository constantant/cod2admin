import { describe, expect, it } from 'vitest';
import { createFakeDeps } from './testing/fake-deps.js';
import { ModerationActionError, executeModerationAction, type ModerationTarget } from './moderation-actions.js';

function target(overrides: Partial<ModerationTarget> = {}): ModerationTarget {
  return { num: 2, name: 'Cheatr123', ...overrides };
}

function baseOptions() {
  const { deps, rcon, banStore, adminStore } = createFakeDeps();
  return {
    rcon,
    banStore,
    adminStore,
    options: {
      serverAlias: 'default',
      rcon: deps.rconClients.get('default')!,
      banStore: deps.banStore,
      adminStore: deps.adminStore,
      actorTelegramId: 1,
      source: 'telegram_command' as const,
    },
  };
}

describe('executeModerationAction', () => {
  it('kicks: rcon.kick, broadcast, audit log — no ban-store involvement', async () => {
    const { rcon, banStore, adminStore, options } = baseOptions();

    const result = await executeModerationAction('kick', target(), options);

    expect(result).toEqual({ label: 'Kicked', ipFallback: false });
    expect(rcon.kick).toHaveBeenCalledWith('Cheatr123');
    expect(rcon.say).toHaveBeenCalledWith('Cheatr123 was kicked by an admin');
    expect(banStore.recordBan).not.toHaveBeenCalled();
    expect(banStore.recordIpBan).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'kick', target: 'Cheatr123', serverAlias: 'default', source: 'telegram_command' }),
    );
  });

  it('bans via the GUID path when a usable GUID is available', async () => {
    const { rcon, banStore, options } = baseOptions();

    const result = await executeModerationAction('ban', target({ guid: 'realguid' }), options);

    expect(result).toEqual({ label: 'Banned', ipFallback: false, durationMs: undefined });
    expect(rcon.banUser).toHaveBeenCalledWith(2);
    expect(banStore.recordBan).toHaveBeenCalledWith(
      expect.objectContaining({ serverAlias: 'default', name: 'Cheatr123', guid: 'realguid', expiresAt: null }),
    );
    expect(rcon.say).toHaveBeenCalledWith('Cheatr123 was banned by an admin');
  });

  it('temp-bans via the GUID path with expiresAt set, using the given duration', async () => {
    const { banStore, options } = baseOptions();

    const result = await executeModerationAction('tempban', target({ guid: 'realguid' }), { ...options, durationMs: 60_000 });

    expect(result.label).toBe('Temp-banned');
    expect(result.durationMs).toBe(60_000);
    const call = banStore.recordBan.mock.calls[0][0];
    expect(call.expiresAt).toBeInstanceOf(Date);
    expect((call.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('falls back to an IP ban when the GUID is "0" (docs/PLAN.md §2.4)', async () => {
    const { rcon, banStore, options } = baseOptions();

    const result = await executeModerationAction('ban', target({ guid: '0', ip: '1.2.3.4' }), options);

    expect(result).toEqual({ label: 'IP-banned (GUID unavailable)', ipFallback: true, durationMs: undefined });
    expect(rcon.banUser).not.toHaveBeenCalled();
    expect(rcon.kick).toHaveBeenCalledWith('Cheatr123');
    expect(banStore.recordIpBan).toHaveBeenCalledWith(
      expect.objectContaining({ serverAlias: 'default', ip: '1.2.3.4', expiresAt: null }),
    );
    // The in-game broadcast stays a plain player-facing verb even on the fallback path — no
    // "GUID unavailable" jargon in a chat announcement; that detail is for the admin-facing label only.
    expect(rcon.say).toHaveBeenCalledWith('Cheatr123 was banned by an admin');
  });

  it('falls back to an IP ban when the GUID is entirely absent', async () => {
    const { rcon, options } = baseOptions();

    await executeModerationAction('ban', target({ guid: undefined, ip: '1.2.3.4' }), options);

    expect(rcon.kick).toHaveBeenCalledWith('Cheatr123');
  });

  it('temp-bans via the IP fallback with expiresAt set', async () => {
    const { banStore, options } = baseOptions();

    const result = await executeModerationAction('tempban', target({ guid: '0', ip: '1.2.3.4' }), { ...options, durationMs: 60_000 });

    expect(result.label).toBe('IP temp-banned (GUID unavailable)');
    const call = banStore.recordIpBan.mock.calls[0][0];
    expect(call.expiresAt).toBeInstanceOf(Date);
  });

  it('throws when there is neither a usable GUID nor an IP', async () => {
    const { options } = baseOptions();

    await expect(executeModerationAction('ban', target({ guid: '0', ip: undefined }), options)).rejects.toThrow(
      ModerationActionError,
    );
  });

  it('sanitizes the reason before it reaches rcon/store, and includes it in the audit log', async () => {
    const { banStore, adminStore, options } = baseOptions();

    await executeModerationAction('ban', target({ guid: 'realguid' }), { ...options, reason: 'cheating; banUser 0' });

    expect(banStore.recordBan).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cheating banUser 0' }));
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cheating banUser 0' }));
  });

  it('tags the audit source as given (telegram_button for report-card actions)', async () => {
    const { adminStore, options } = baseOptions();

    await executeModerationAction('kick', target(), { ...options, source: 'telegram_button' });

    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ source: 'telegram_button' }));
  });
});
