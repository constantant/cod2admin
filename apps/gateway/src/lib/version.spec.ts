import { describe, expect, it } from 'vitest';
import { getRunningVersion, isNewerVersion } from './version.js';

describe('getRunningVersion', () => {
  it('reads a non-empty dotted version string from package.json', () => {
    expect(getRunningVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('isNewerVersion', () => {
  it('reports a higher patch/minor/major as newer', () => {
    expect(isNewerVersion('0.0.5', '0.0.4')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.0.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
  });

  it('strips a leading v from the tag', () => {
    expect(isNewerVersion('v0.0.5', '0.0.4')).toBe(true);
  });

  it('is false for equal or older versions', () => {
    expect(isNewerVersion('0.0.4', '0.0.4')).toBe(false);
    expect(isNewerVersion('0.0.3', '0.0.4')).toBe(false);
  });

  it('is false for anything that does not parse as dotted numbers', () => {
    expect(isNewerVersion('not-a-version', '0.0.4')).toBe(false);
    expect(isNewerVersion('0.0.5-rc1', '0.0.4')).toBe(false);
  });
});
