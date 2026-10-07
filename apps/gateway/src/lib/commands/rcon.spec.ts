import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { buildRconReply, rconCommand } from './rcon.js';

describe('rconCommand', () => {
  it('sends the raw command verbatim, replies with the output, and audit-logs it', async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    rcon.rcon.mockResolvedValue('Kicked player 3');
    const ctx = createFakeCtx({ match: 'kick 3', admin: { telegramId: 1, role: 'owner' } });

    await rconCommand(ctx, deps);

    expect(rcon.rcon).toHaveBeenCalledWith('kick 3');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rcon', target: 'kick 3', detailJson: { command: 'kick 3' } }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('Kicked player 3');
  });

  it('replies with a placeholder when the command has no output', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.rcon.mockResolvedValue('');
    const ctx = createFakeCtx({ match: 'noop', admin: { telegramId: 1, role: 'owner' } });

    await rconCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith('(no output)');
  });

  it('prompts for usage when no command is given', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'owner' } });

    await rconCommand(ctx, deps);

    expect(rcon.rcon).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /rcon <raw command> [--server <alias>]');
  });
});

describe('long /rcon output', () => {
  it('shows the first 20 lines and attaches the full output in a code block', async () => {
    const { deps, rcon } = createFakeDeps();
    const output = Array.from({ length: 45 }, (_, i) => 'line ' + i + ' with ``` backticks').join('\n');
    rcon.rcon.mockResolvedValue(output);
    const ctx = createFakeCtx({ match: 'status', admin: { telegramId: 1, role: 'owner' } });

    await rconCommand(ctx, deps);

    const [, other] = vi.mocked(ctx.replyWithDocument!).mock.calls[0]!;
    const caption = (other as { caption?: string } | undefined)?.caption ?? vi.mocked(ctx.reply).mock.calls[0]![0];
    expect(caption).toContain('line 19 with');
    expect(caption).not.toContain('line 20 with');
    expect(caption).toContain('45 lines in total');

    const report = buildRconReply('status', 'default', output, new Date('2026-10-07T10:00:00Z')).markdown;
    expect(report).toContain('- Command: status');
    expect(report).toContain('````\nline 0 with ``` backticks');
    expect(report).toContain('line 44 with ``` backticks\n````');
  });
});
