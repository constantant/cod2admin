/** One group of changes in a release, e.g. "Features". `title` is empty for loose lines. */
export interface NoteSection {
  title: string;
  items: string[];
}

/** `([abc1234](https://…/commit/abc1234))`, possibly several in a row: noise in a phone's list. */
const COMMIT_REFS =
  /\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)(?:,\s*\[[0-9a-f]{7,40}\]\([^)]*\))*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;
const BOLD = /\*\*([^*]+)\*\*/g;
/** The "thank you" list of contributors, which `nx release` adds to every release. */
const THANKS = /thank you/i;

function clean(text: string): string {
  return text
    .replace(COMMIT_REFS, '')
    .replace(LINK, '$1')
    .replace(BOLD, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * Turns a GitHub release body (markdown from `nx release`) into sections of plain lines: the
 * version heading, commit links, markdown markup and the contributors list are dropped. Plain
 * text, so the page can show it without rendering HTML.
 */
export function parseReleaseNotes(markdown: string): NoteSection[] {
  const sections: NoteSection[] = [];
  let current: NoteSection | null = null;
  let skipping = false;
  const open = (title: string): NoteSection => {
    current = { title, items: [] };
    sections.push(current);
    return current;
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      if (heading[1]!.length <= 2) {
        // "## [1.21.0](…) (2026-11-09)": the page shows the version and date itself.
        skipping = false;
        continue;
      }
      // "### 🚀 Features" → "Features". A heading with no letters ("### 0.0.5") says nothing.
      const title = clean(heading[2]!).replace(/^[^\p{L}]+/u, '');
      skipping = THANKS.test(title);
      if (!skipping && title) {
        open(title);
      }
      continue;
    }
    if (skipping) {
      continue;
    }
    const text = clean(line.replace(/^[-*+]\s+/, ''));
    if (text) {
      (current ?? open('')).items.push(text);
    }
  }
  return sections.filter((section) => section.items.length > 0);
}
