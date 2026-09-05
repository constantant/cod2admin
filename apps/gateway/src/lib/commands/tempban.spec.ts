import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { formatDuration, tempbanCommand } from './tempban.js';

describe('formatDuration', () => {
  it('formats minutes, hours, and days', () => {
    expect(formatDuration(30 * 60_000)).toBe('30m');
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
    expect(formatDuration(1 * 86_400_000)).toBe('1d');
  });
});

describe('tempbanCommand', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('kicks, IP-bans with the default 30m duration, and audit-logs it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { deps, rcon, banStore, adminStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [{ num: 3, score: 0, ping: 0, name: 'Griefer', ip: '1.2.3.4' }] });
    const ctx = createFakeCtx({ match: '3', admin: { telegramId: 1, role: 'admin' } });

    await tempbanCommand(ctx, deps);

    expect(rcon.kick).toHaveBeenCalledWith('Griefer');
    expect(banStore.recordIpBan).toHaveBeenCalledWith({
      serverAlias: 'default',
      ip: '1.2.3.4',
      reason: null,
      bannedBy: 1,
      expiresAt: new Date('2026-01-01T00:30:00.000Z'),
    });
    expect(rcon.say).toHaveBeenCalledWith('Griefer was temp-banned by an admin');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'tempban', target: 'Griefer' }));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Temp-banned Griefer's IP for 30m."));
  });

  it('parses an explicit duration and reason', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [{ num: 3, score: 0, ping: 0, name: 'Griefer', ip: '1.2.3.4' }] });
    const ctx = createFakeCtx({ match: '3 2h teamkilling', admin: { telegramId: 1, role: 'admin' } });

    await tempbanCommand(ctx, deps);

    expect(banStore.recordIpBan).toHaveBeenCalledWith(expect.objectContaining({ reason: 'teamkilling' }));
    const [[callArg]] = banStore.recordIpBan.mock.calls;
    const durationMs = (callArg.expiresAt as Date).getTime() - Date.now();
    expect(Math.round(durationMs / 3_600_000)).toBe(2);
  });

  it('treats a non-duration second token as the start of the reason (default duration)', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [{ num: 3, score: 0, ping: 0, name: 'Griefer', ip: '1.2.3.4' }] });
    const ctx = createFakeCtx({ match: '3 teamkilling repeatedly', admin: { telegramId: 1, role: 'admin' } });

    await tempbanCommand(ctx, deps);

    expect(banStore.recordIpBan).toHaveBeenCalledWith(expect.objectContaining({ reason: 'teamkilling repeatedly' }));
  });

  it('refuses when the client id is not currently connected', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [] });
    const ctx = createFakeCtx({ match: '3', admin: { telegramId: 1, role: 'admin' } });

    await tempbanCommand(ctx, deps);

    expect(rcon.kick).not.toHaveBeenCalled();
    expect(banStore.recordIpBan).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Client 3 is not currently connected (or has no IP) — cannot IP-ban.');
  });

  it('prompts for usage when the client id is missing or not a number', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'not-a-number', admin: { telegramId: 1, role: 'admin' } });

    await tempbanCommand(ctx, deps);

    expect(rcon.status).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /tempban <client id> [duration] [reason] [--server <alias>]');
  });
});
