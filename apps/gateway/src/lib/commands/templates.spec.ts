import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_TEMPLATES_SETTING_KEY,
  DEFAULT_CHAT_TEMPLATES,
} from '../chat-templates.js';
import { ADMIN_ACCESS } from '../testing/fake-admin-store.js';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { templatesCommand } from './templates.js';

const ADMIN = { telegramId: 7, ...ADMIN_ACCESS };

function ctx(match: string) {
  return createFakeCtx({ match, admin: ADMIN });
}

function replyText(c: ReturnType<typeof ctx>): string {
  return vi.mocked(c.reply).mock.calls[0]![0] as string;
}

describe('templatesCommand', () => {
  it('lists the built-in lines, with the VPN kick sending nothing', async () => {
    const { deps } = createFakeDeps();
    const c = ctx('');

    await templatesCommand(c, deps);

    const text = replyText(c);
    expect(text).toContain(`kick (everyone): ${DEFAULT_CHAT_TEMPLATES.kick}`);
    expect(text).toContain('vpn_kick (everyone): (sends nothing)');
    expect(text).toContain('mute_warn (private):');
  });

  it('sets, clears and resets one line, saving and auditing', async () => {
    const { deps, adminStore } = createFakeDeps();

    await templatesCommand(ctx('set vpn_kick {name} out: {kind}'), deps);
    expect(deps.chatTemplates.get('vpn_kick')).toBe('{name} out: {kind}');
    expect(adminStore.setSetting).toHaveBeenLastCalledWith(
      CHAT_TEMPLATES_SETTING_KEY,
      expect.objectContaining({ vpn_kick: '{name} out: {kind}' }),
    );
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'templates',
        actorTelegramId: 7,
        detailJson: { id: 'vpn_kick', text: '{name} out: {kind}' },
      }),
    );

    const cleared = ctx('clear kick');
    await templatesCommand(cleared, deps);
    expect(deps.chatTemplates.get('kick')).toBe('');
    expect(replyText(cleared)).toBe('kick: (sends nothing)');

    await templatesCommand(ctx('reset kick'), deps);
    expect(deps.chatTemplates.get('kick')).toBe(DEFAULT_CHAT_TEMPLATES.kick);
    expect(deps.chatTemplates.get('vpn_kick')).toBe('{name} out: {kind}');
  });

  it('refuses an unknown id', async () => {
    const { deps, adminStore } = createFakeDeps();
    const c = ctx('set nope hello');

    await templatesCommand(c, deps);

    expect(replyText(c)).toContain('/templates set <id> <text>');
    expect(adminStore.setSetting).not.toHaveBeenCalled();
  });
});
