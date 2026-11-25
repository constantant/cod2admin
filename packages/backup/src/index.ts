export {
  BackupCryptoError,
  MIN_PASSPHRASE_LENGTH,
  assertPassphrase,
  decryptStream,
  encryptStream,
} from './lib/crypto.js';
export { exportBackup, exportBackupToFile } from './lib/export.js';
export type { ExportOptions, ExportResult } from './lib/export.js';
export { BACKUP_FORMAT, BackupError } from './lib/format.js';
export type { Manifest, SecretCodec } from './lib/format.js';
export { joinParts, splitFile } from './lib/parts.js';
export {
  BACKUP_GROUPS,
  DEFAULT_GROUPS,
  EXCLUDED_TABLES,
  GROUP_TABLES,
  isBackupGroup,
} from './lib/registry.js';
export type { BackupGroup } from './lib/registry.js';
export { restoreBackup } from './lib/import.js';
export type {
  RestoreOptions,
  RestoreReport,
  TableReport,
} from './lib/import.js';
