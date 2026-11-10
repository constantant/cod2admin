import { parseReleaseNotes } from './release-notes';

const BODY = `## [1.21.0](https://github.com/x/y/releases/tag/v1.21.0) (2026-11-09)

### 🚀 Features

- add known players — nicknames tied to provider networks ([dab8465](https://github.com/x/y/commit/dab8465))
- **miniapp:** show a **bold** thing ([f863bcd](https://github.com/x/y/commit/f863bcd), [cb602bd](https://github.com/x/y/commit/cb602bd))

### 🩹 Fixes

- see [the docs](https://example.com) for \`mp_x\`

### ❤️ Thank You

- Claude Sonnet 5.5
- kk
`;

describe('parseReleaseNotes', () => {
  it('groups the lines and drops hashes, markup and the contributors list', () => {
    expect(parseReleaseNotes(BODY)).toEqual([
      {
        title: 'Features',
        items: [
          'add known players — nicknames tied to provider networks',
          'miniapp: show a bold thing',
        ],
      },
      { title: 'Fixes', items: ['see the docs for mp_x'] },
    ]);
  });

  it('keeps plain lists with no sections, and ignores a bare version heading', () => {
    expect(parseReleaseNotes('### 0.0.5\n\n- did a thing')).toEqual([
      { title: '', items: ['did a thing'] },
    ]);
  });

  it('is empty for an empty body', () => {
    expect(parseReleaseNotes('')).toEqual([]);
  });
});
