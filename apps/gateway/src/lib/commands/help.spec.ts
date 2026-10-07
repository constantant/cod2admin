import type { InputFile } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { formatShortHelp, helpCommand, helpRuCommand, type HelpAudience } from './help.js';

const AUDIENCES: HelpAudience[] = ['player', 'moderator', 'admin', 'owner'];

describe('formatShortHelp', () => {
  it('shows a player only how to report', () => {
    const text = formatShortHelp('player', 'en');

    expect(text).toContain('!report <name> <reason>');
    expect(text).not.toContain('/kick');
    expect(text).toContain('/help_ru');
  });

  it('adds commands by role, each role seeing everything below it', () => {
    const moderator = formatShortHelp('moderator', 'en');
    const admin = formatShortHelp('admin', 'en');
    const owner = formatShortHelp('owner', 'en');

    expect(moderator).toContain('your role: moderator');
    expect(moderator).toContain('/kick');
    expect(moderator).not.toContain('/ban <id>');
    expect(admin).toContain('/kick');
    expect(admin).toContain('/ban <id>');
    expect(admin).not.toContain('/auditlog');
    expect(owner).toContain('/auditlog');
    expect(owner).toContain('/update');
  });

  it.each(AUDIENCES.flatMap((audience) => [[audience, 'en'] as const, [audience, 'ru'] as const]))(
    'keeps the %s/%s text short enough to be a file caption (1024) and a quick read',
    (audience, language) => {
      const text = formatShortHelp(audience, language);

      expect(text.length).toBeLessThanOrEqual(1024);
      expect(text.split('\n').length).toBeLessThanOrEqual(18);
    },
  );

  it('has the Russian text in Russian', () => {
    expect(formatShortHelp('admin', 'ru')).toContain('ваша роль: admin');
    expect(formatShortHelp('player', 'ru')).toContain('!report <имя> <причина>');
  });
});

describe('helpCommand / helpRuCommand', () => {
  it('sends the role-based short text as the caption of the attached full guide', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.getAdmin.mockResolvedValue({ telegramId: 5, role: 'admin' } as never);
    const ctx = createFakeCtx({ from: { id: 5 } });

    await helpCommand(ctx, deps);

    expect(adminStore.getAdmin).toHaveBeenCalledWith(5);
    expect(ctx.reply).not.toHaveBeenCalled();
    const [file, other] = vi.mocked(ctx.replyWithDocument!).mock.calls[0]!;
    expect((file as InputFile).filename).toBe('cod2admin-help.md');
    expect(other).toEqual({ caption: formatShortHelp('admin', 'en') });
  });

  it('treats someone without a role as a player, and sends the Russian guide for /help_ru', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.getAdmin.mockResolvedValue(undefined);
    const ctx = createFakeCtx({ from: { id: 9 } });

    await helpRuCommand(ctx, deps);

    const [file, other] = vi.mocked(ctx.replyWithDocument!).mock.calls[0]!;
    expect((file as InputFile).filename).toBe('cod2admin-help-ru.md');
    expect(other).toEqual({ caption: formatShortHelp('player', 'ru') });
  });

  it('falls back to the short text alone where files can\'t be sent', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCtx({ replyWithDocument: undefined });

    await helpCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(formatShortHelp('player', 'en'));
  });
});
