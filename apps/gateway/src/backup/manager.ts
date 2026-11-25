import { stat } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { SecretBox, type AdminStore } from '@cod2admin/admin-store';
import {
  BackupCryptoError,
  MIN_PASSPHRASE_LENGTH,
  splitFile,
  type BackupGroup,
} from '@cod2admin/backup';
import type {
  BackupRunInfo,
  BackupSchedule,
} from '../miniapp/api-types.js';
import {
  DEFAULT_SCHEDULE,
  LAST_RUN_KEY,
  PASSPHRASE_KEY,
  SCHEDULE_KEY,
  isDue,
  parseSchedule,
  sinceOf,
  validateSchedule,
} from './schedule.js';
import type { BackupService, CreatedBackup } from './service.js';

/** Telegram's Bot API takes documents up to 50 MB; stay clear of it. */
export const TELEGRAM_PART_BYTES = 45 * 1024 * 1024;

export interface BackupSender {
  sendDocument(chatId: number, path: string, caption: string): Promise<void>;
  sendMessage(chatId: number, text: string): Promise<void>;
}

export interface BackupManagerOptions {
  adminStore: AdminStore;
  service: BackupService;
  secretsKey: string;
  /** `BACKUP_PASSPHRASE`, which wins over a saved one. */
  envPassphrase?: string;
  sender: BackupSender;
  now?: () => Date;
  /** Waits between tries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Replaces `process.exit(1)`. A nonzero exit makes systemd and OpenRC start the bot again. */
  restart?: () => void;
  /** For tests: the Telegram size limit. */
  partBytes?: number;
}

const RETRY_WAITS_MS = [30_000, 120_000];

/** Optional groups, dropped in this order when the file does not fit in a Telegram message. */
const DROP_ORDER: BackupGroup[] = ['watch', 'history'];

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export class BackupManager {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly box: SecretBox;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: BackupManagerOptions) {
    this.box = new SecretBox(options.secretsKey);
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get service(): BackupService {
    return this.options.service;
  }

  get sender(): BackupSender {
    return this.options.sender;
  }

  /** Runs `work` while no scheduled backup can start (a restore must not race one). */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.running) {
      throw new BackupCryptoError('A backup is running right now. Try again in a minute.');
    }
    this.running = true;
    try {
      return await work();
    } finally {
      this.running = false;
    }
  }

  /** After a restore the gateway's in-memory state is stale; a restart picks the new data up. */
  restartSoon(): void {
    const restart = this.options.restart ?? (() => process.exit(1));
    setTimeout(restart, 1500).unref();
  }

  async getSchedule(): Promise<BackupSchedule> {
    const stored = await this.options.adminStore.getSetting(SCHEDULE_KEY);
    return stored === undefined ? { ...DEFAULT_SCHEDULE } : parseSchedule(stored);
  }

  /** Turning it on needs a passphrase, since a schedule that fails every night helps nobody. */
  async setSchedule(input: unknown): Promise<BackupSchedule> {
    const schedule = validateSchedule(input);
    if (schedule.enabled && !(await this.getPassphrase())) {
      throw new BackupCryptoError(
        'Set a backup passphrase before turning the schedule on.',
      );
    }
    const before = await this.getSchedule();
    const stored = await this.options.adminStore.getSetting(SCHEDULE_KEY);
    const since =
      schedule.enabled && !before.enabled ? this.now() : sinceOf(stored);
    await this.options.adminStore.setSetting(SCHEDULE_KEY, {
      ...schedule,
      since: since.toISOString(),
    });
    return schedule;
  }

  async getLastRun(): Promise<BackupRunInfo | null> {
    const stored = await this.options.adminStore.getSetting(LAST_RUN_KEY);
    return stored && typeof stored === 'object'
      ? (stored as BackupRunInfo)
      : null;
  }

  private async saveLastRun(run: BackupRunInfo): Promise<void> {
    await this.options.adminStore.setSetting(LAST_RUN_KEY, run);
  }

  passphraseFromConfig(): boolean {
    return Boolean(this.options.envPassphrase);
  }

  async getPassphrase(): Promise<string | undefined> {
    if (this.options.envPassphrase) return this.options.envPassphrase;
    const stored = await this.options.adminStore.getSetting(PASSPHRASE_KEY);
    return typeof stored === 'string' ? this.box.decrypt(stored) : undefined;
  }

  async setPassphrase(passphrase: string | null): Promise<void> {
    if (this.options.envPassphrase) {
      throw new BackupCryptoError(
        'The passphrase is set in the bot config (BACKUP_PASSPHRASE); change it there.',
      );
    }
    if (passphrase === null) {
      await this.options.adminStore.deleteSetting(PASSPHRASE_KEY);
      const schedule = await this.getSchedule();
      if (schedule.enabled) {
        await this.options.adminStore.setSetting(SCHEDULE_KEY, {
          ...schedule,
          enabled: false,
          since: new Date(0).toISOString(),
        });
      }
      return;
    }
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new BackupCryptoError(
        `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
      );
    }
    await this.options.adminStore.setSetting(
      PASSPHRASE_KEY,
      this.box.encrypt(passphrase),
    );
  }

  private async ownerId(): Promise<number | undefined> {
    const admins = await this.options.adminStore.listAdmins();
    return admins.find((admin) => admin.isOwner)?.telegramId;
  }

  /**
   * One scheduled (or "send now") backup: file on the host first, then the owner's chat. A failed
   * send never loses the file. Returns what happened; the same text goes to the owner on failure.
   */
  async runNow(): Promise<BackupRunInfo> {
    if (this.running) {
      return {
        at: this.now().toISOString(),
        ok: false,
        message: 'A backup is already running.',
      };
    }
    this.running = true;
    try {
      const run = await this.runOnce();
      await this.saveLastRun(run);
      return run;
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<BackupRunInfo> {
    const at = this.now().toISOString();
    const schedule = await this.getSchedule();
    const owner = await this.ownerId();
    try {
      const passphrase = await this.getPassphrase();
      if (!passphrase) {
        throw new BackupCryptoError('No backup passphrase is set.');
      }
      const created = await this.options.service.createFile({
        groups: schedule.groups,
        passphrase,
      });
      let note = '';
      if (schedule.telegram === 'file') {
        const fit = await this.fitForTelegram(created, schedule, passphrase);
        note = fit.note;
        try {
          await this.deliverFile(owner, fit.file, fit.note);
        } finally {
          if (fit.temporary) await rm(fit.file.path, { force: true });
        }
      } else if (schedule.telegram === 'notify') {
        await this.notify(
          owner,
          `cod2admin backup ready on the host: ${created.name} (${mb(created.bytes)}).`,
        );
      }
      await this.options.service.prune(schedule.keepLocal);
      return {
        at,
        ok: true,
        bytes: created.bytes,
        message: `Saved ${created.name} (${mb(created.bytes)}).${note}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = `Backup failed: ${message}`;
      try {
        await this.notify(owner, failed);
      } catch {
        // The owner could not be told either; lastRun still shows it on the page.
      }
      return { at, ok: false, message: failed };
    }
  }

  /**
   * Over Telegram's limit: send a copy without the optional groups (the host copy keeps them),
   * and split into parts only if that is still too big.
   */
  private async fitForTelegram(
    created: CreatedBackup,
    schedule: BackupSchedule,
    passphrase: string,
  ): Promise<{ file: CreatedBackup; note: string; temporary: boolean }> {
    const limit = this.options.partBytes ?? TELEGRAM_PART_BYTES;
    let current = created;
    let groups = [...schedule.groups];
    let note = '';
    let temporary = false;
    for (const drop of DROP_ORDER) {
      if (current.bytes <= limit) break;
      if (!groups.includes(drop)) continue;
      groups = groups.filter((group) => group !== drop);
      if (temporary) await rm(current.path, { force: true });
      current = await this.options.service.createFile({
        groups,
        passphrase,
        prefix: 'send',
      });
      temporary = true;
      note += ` Sent without ${drop} (the full ${mb(created.bytes)} file is over Telegram's limit; it is kept on the host).`;
    }
    return { file: current, note, temporary };
  }

  private async notify(owner: number | undefined, text: string): Promise<void> {
    if (owner === undefined) return;
    await this.withRetries(() => this.options.sender.sendMessage(owner, text));
  }

  private async withRetries(work: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= RETRY_WAITS_MS.length) throw error;
        await this.sleep(RETRY_WAITS_MS[attempt]);
      }
    }
  }

  /** One document, or several parts when even the smallest file is over the limit. */
  private async deliverFile(
    owner: number | undefined,
    file: CreatedBackup,
    note: string,
  ): Promise<void> {
    if (owner === undefined) return;
    const limit = this.options.partBytes ?? TELEGRAM_PART_BYTES;
    const rows = Object.values(file.counts).reduce((a, b) => a + b, 0);
    const caption = (part: string) =>
      [
        `cod2admin backup ${file.name}${part}`,
        `${mb(file.bytes)}, ${rows} rows.${note}`,
        'Encrypted: restoring needs your backup passphrase.',
      ].join('\n');
    if ((await stat(file.path)).size <= limit) {
      await this.withRetries(() =>
        this.options.sender.sendDocument(owner, file.path, caption('')),
      );
      return;
    }
    const parts = await splitFile(file.path, limit);
    try {
      for (const [index, part] of parts.entries()) {
        await this.withRetries(() =>
          this.options.sender.sendDocument(
            owner,
            part,
            caption(` (part ${index + 1} of ${parts.length}, join them in order)`),
          ),
        );
      }
    } finally {
      for (const part of parts) await rm(part, { force: true });
    }
  }

  /** Checks once a minute; a missed slot runs at the next tick, including right after a start. */
  start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.tick().catch((error: unknown) =>
        console.error('Scheduled backup check failed:', error),
      );
    };
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<boolean> {
    const schedule = await this.getSchedule();
    const since = sinceOf(await this.options.adminStore.getSetting(SCHEDULE_KEY));
    const last = await this.getLastRun();
    const lastAttempt = last ? new Date(last.at) : undefined;
    if (!isDue(schedule, this.now(), since, lastAttempt)) return false;
    await this.runNow();
    return true;
  }
}
