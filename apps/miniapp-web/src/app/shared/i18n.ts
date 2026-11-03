import { Pipe, type PipeTransform } from '@angular/core';
import WebApp from '@twa-dev/sdk';
import { RU_PATTERNS, RU_TEXT } from './i18n-ru';

export type Language = 'en' | 'ru';

const LANGUAGE_KEY = 'cod2admin.language';

function storedLanguage(): Language | null {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    return stored === 'en' || stored === 'ru' ? stored : null;
  } catch {
    return null;
  }
}

function detectLanguage(): Language {
  const asked =
    WebApp.initDataUnsafe?.user?.language_code ??
    (typeof navigator === 'undefined' ? '' : navigator.language);
  return asked?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Fixed for the page's life: changing it reloads, so every text can simply be looked up once. */
export const language: Language = storedLanguage() ?? detectLanguage();

/** For dates: Russian when the app is, else whatever the device uses. */
export const dateLocale: string[] = language === 'ru' ? ['ru'] : [];

export function setLanguage(next: Language): void {
  try {
    localStorage.setItem(LANGUAGE_KEY, next);
  } catch {
    // Storage can be off in a WebView: the choice can't outlive the reload then.
  }
  location.reload();
}

/** Looks up English text in a language's catalogue: exact first, then patterns. Unknown stays as it is. */
export function translate(text: string, target: Language): string {
  if (target === 'en' || !text) {
    return text;
  }
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const exact = RU_TEXT[trimmed];
  if (exact !== undefined) {
    return exact;
  }
  for (const [pattern, replace] of RU_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) {
      return replace(...match.slice(1));
    }
  }
  return text;
}

/**
 * The text in the current language. English is the key, so a text with no translation yet shows in
 * English instead of breaking. The gateway writes English too (its messages also go in the audit
 * log and to the chat), so what it says goes through here as well.
 */
export function t(text: string): string {
  return translate(text, language);
}

@Pipe({ name: 't' })
export class T implements PipeTransform {
  transform(text: string | null | undefined): string {
    return t(text ?? '');
  }
}
