import type { BackupGroup } from './registry.js';

export const BACKUP_FORMAT = 1;

/** The encrypted codec for secret columns, structurally the same as admin-store's `SecretBox`. */
export interface SecretCodec {
  encrypt(plaintext: string): string;
  decrypt(encoded: string): string;
}

export interface ManifestTable {
  name: string;
  group: BackupGroup;
  columns: string[];
}

export interface Manifest {
  t: 'manifest';
  format: number;
  app: string;
  created: string;
  groups: BackupGroup[];
  tables: ManifestTable[];
}

export interface RowLine {
  t: 'r';
  n: string;
  v: unknown[];
}

export interface EndLine {
  t: 'end';
  counts: Record<string, number>;
}

export type BackupLine = Manifest | RowLine | EndLine;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}
