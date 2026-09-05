import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Encrypts secrets at rest (docs/PLAN.md §7 — rcon passwords etc.) with AES-256-GCM keyed by
 * `SECRETS_ENCRYPTION_KEY`. Equivalent security property to the libsodium secretbox the plan
 * suggests, using Node's built-in `crypto` instead of adding a new dependency.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error(
        `SECRETS_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}. Generate one with: ` +
          `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    this.key = key;
  }

  /** Returns `iv:authTag:ciphertext`, each base64, colon-joined. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv, authTag, ciphertext].map((part) => part.toString('base64')).join(':');
  }

  decrypt(encoded: string): string {
    const [ivB64, authTagB64, ciphertextB64] = encoded.split(':');
    if (!ivB64 || !authTagB64 || !ciphertextB64) {
      throw new Error('Malformed encrypted value — expected "iv:authTag:ciphertext"');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  }
}
