import type { InputFile } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import {
  ADMIN_ACCESS,
  MODERATOR_ACCESS,
  OWNER_ACCESS,
  sampleAdmin,
} from '../testing/fake-admin-store.js';
import {
  formatShortHelp,
  helpCommand,
  helpRuCommand,
  type HelpAudience,
} from './help.js';

const AUDIENCES: Record<string, HelpAudience> = {
  player: 'player',
  moderator: MODERATOR_ACCESS,
  admin: ADMIN_ACCESS,
  owner: OWNER_ACCESS,
};

describe('formatShortHelp', () => {
  it('shows a player only how to report', () => {
    const text = formatShortHelp('player', 'en');

    expect(text).toContain('!report <name> <reason>');
    expect(text).not.toContain('/kick');
    expect(text).not.toContain('your role');
    expect(text).toContain('/help_ru');
  });

  it('shows a line only when the caller holds that permission', () => {
    const moderator = formatShortHelp(MODERATOR_ACCESS, 'en');
    const admin = formatShortHelp(ADMIN_ACCESS, 'en');
    const owner = formatShortHelp(OWNER_ACCESS, 'en');

    expect(moderator).not.toContain('your role');
    expect(moderator).toContain('/app');
    expect(moderator).toContain('/kick');
    expect(moderator).toContain('/tempban');
    expect(moderator).not.toContain('/ban <id>');
    expect(moderator).not.toContain('/permit');
    expect(admin).toContain('/kick');
    expect(admin).toContain('/ban <id>');
    expect(admin).toContain('/permit');
    expect(admin).not.toContain('/auditlog');
    expect(admin).not.toContain('/update');
    expect(owner).toContain('/auditlog');
    expect(owner).toContain('/update');
    expect(owner).toContain('/permit');
  });

  it.each(
    Object.entries(AUDIENCES).flatMap(([name, audience]) => [
      [name, audience, 'en'] as const,
      [name, audience, 'ru'] as const,
    ]),
  )(
    'keeps the %s/%s text short enough to be a file caption (1024) and a quick read',
    (_name, audience, language) => {
      const text = formatShortHelp(audience, language);

      expect(text.length).toBeLessThanOrEqual(1024);
      expect(text.split('\n').length).toBeLessThanOrEqual(18);
    },
  );

  it('has the Russian text in Russian, without naming a role', () => {
    const text = formatShortHelp(ADMIN_ACCESS, 'ru');
    expect(text).not.toContain('ваша роль');
    expect(text).toContain('/kick <id или имя>');
    expect(formatShortHelp('player', 'ru')).toContain(
      '!report <имя> <причина>',
    );
  });
});

describe('helpCommand / helpRuCommand', () => {
  it("sends the caller's short text as the caption of the attached full guide", async () => {
    const { deps, adminStore } = createFakeDeps();
    const admin = sampleAdmin({ telegramId: 5, ...ADMIN_ACCESS });
    adminStore.getAdmin.mockResolvedValue(admin);
    const ctx = createFakeCtx({ from: { id: 5 } });

    await helpCommand(ctx, deps);

    expect(adminStore.getAdmin).toHaveBeenCalledWith(5);
    expect(ctx.reply).not.toHaveBeenCalled();
    const [file, other] = vi.mocked(ctx.replyWithDocument!).mock.calls[0]!;
    expect((file as InputFile).filename).toBe('cod2admin-help.md');
    expect(other).toEqual({ caption: formatShortHelp(admin, 'en') });
  });

  it('treats someone who is not staff as a player, and sends the Russian guide for /help_ru', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.getAdmin.mockResolvedValue(undefined);
    const ctx = createFakeCtx({ from: { id: 9 } });

    await helpRuCommand(ctx, deps);

    const [file, other] = vi.mocked(ctx.replyWithDocument!).mock.calls[0]!;
    expect((file as InputFile).filename).toBe('cod2admin-help-ru.md');
    expect(other).toEqual({ caption: formatShortHelp('player', 'ru') });
  });

  it("falls back to the short text alone where files can't be sent", async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCtx({ replyWithDocument: undefined });

    await helpCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(formatShortHelp('player', 'en'));
  });
});
