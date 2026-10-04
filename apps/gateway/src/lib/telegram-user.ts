/**
 * How the bot names a Telegram user in its messages: `@nick (123)`, `First name (123)` without a
 * username, or the bare ID if no name is known yet (they haven't used the bot since names began
 * being remembered — see `saveTelegramUser` in admin-store). The ID always stays, since it's what
 * `/removeadmin`/`/setrole` take.
 */
export function formatTelegramUser(
  telegramId: number,
  username: string | null | undefined,
  firstName: string | null | undefined,
): string {
  const name = username ? `@${username}` : firstName;
  return name ? `${name} (${telegramId})` : String(telegramId);
}
