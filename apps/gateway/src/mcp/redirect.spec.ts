import { describe, expect, it } from 'vitest';
import {
  displayName,
  isAllowedRedirect,
  isBlockedAddress,
  isBlockedHostname,
} from './redirect.js';

describe('isBlockedAddress', () => {
  it('blocks private, loopback, link-local and documentation ranges', () => {
    for (const address of [
      '0.0.0.1',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.1',
      '198.51.100.1',
      '203.0.113.5',
      '224.0.0.1',
      '240.0.0.1',
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('leaves public addresses alone, including the nets next to the documentation ranges', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '11.0.0.1',
      '172.32.0.1',
      '192.0.1.1',
      '198.20.0.1',
      '203.0.114.1',
      '::ffff:8.8.8.8',
      '2001:4860:4860::8888',
    ]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });
});

describe('isAllowedRedirect', () => {
  it('allows https on a public host and http only on loopback', () => {
    expect(isAllowedRedirect('https://app.example/callback')).toBe(true);
    expect(isAllowedRedirect('http://127.0.0.1:8787/callback')).toBe(true);
    expect(isAllowedRedirect('http://localhost:8787/callback')).toBe(true);
    expect(isAllowedRedirect('http://[::1]:8787/callback')).toBe(true);
  });

  it('rejects private hosts, credentials and fragments', () => {
    expect(isAllowedRedirect('http://192.168.1.1/callback')).toBe(false);
    expect(isAllowedRedirect('https://192.168.0.1/callback')).toBe(false);
    expect(isAllowedRedirect('https://user:pass@app.example/callback')).toBe(
      false,
    );
    expect(isAllowedRedirect('https://app.example/callback#code')).toBe(false);
    expect(isAllowedRedirect('javascript:alert(1)')).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it('blocks local names and the cloud metadata host', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('app.localhost')).toBe(true);
    expect(isBlockedHostname('printer.local')).toBe(true);
    expect(isBlockedHostname('db.internal')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
    expect(isBlockedHostname('app.example')).toBe(false);
  });
});

describe('displayName', () => {
  it('collapses control characters and caps the length', () => {
    expect(displayName('Example\nApp')).toBe('Example App');
    expect(displayName('')).toBe('Unnamed application');
    expect(displayName('x'.repeat(200))).toHaveLength(80);
  });
});
