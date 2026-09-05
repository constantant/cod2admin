import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secrets.js';

describe('SecretBox', () => {
  it('round-trips a plaintext value', () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));

    const encrypted = box.encrypt('hunter2');

    expect(encrypted).not.toContain('hunter2');
    expect(box.decrypt(encrypted)).toBe('hunter2');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));

    expect(box.encrypt('hunter2')).not.toBe(box.encrypt('hunter2'));
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new SecretBox(Buffer.from('too-short').toString('base64'))).toThrow(/32 bytes/);
  });

  it('rejects a tampered ciphertext', () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));
    const encrypted = box.encrypt('hunter2');
    const tampered = encrypted.slice(0, -4) + 'AAAA';

    expect(() => box.decrypt(tampered)).toThrow();
  });
});
