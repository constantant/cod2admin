import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BACKUP_GROUPS,
  BackupCryptoError,
  BackupError,
  DEFAULT_GROUPS,
  GROUP_TABLES,
  isBackupGroup,
} from '@cod2admin/backup';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BACKUP_FILE_NAME } from '../backup/service.js';
import { ScheduleError } from '../backup/schedule.js';
import type { GatewayDeps } from '../lib/deps.js';
import { ApiProblem } from './api-problem.js';
import type {
  ActionResponse,
  BackupFileDto,
  BackupGroup,
  BackupPreviewRequest,
  BackupPreviewResponse,
  BackupRestoreRequest,
  BackupRestoreResponse,
  BackupSchedule,
  BackupSetPassphraseRequest,
  BackupSource,
  BackupStatusResponse,
  BackupUploadResponse,
  CreateBackupRequest,
} from './api-types.js';

/** A backup is database rows, not game files; this is far above any real one. */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const TELEGRAM_LIMIT = 50 * 1024 * 1024;

/** Library errors that are the caller's doing become a 400 with the reason. */
function userError<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    if (
      error instanceof BackupCryptoError ||
      error instanceof BackupError ||
      error instanceof ScheduleError
    ) {
      throw new ApiProblem(400, 'bad_request', error.message);
    }
    throw error;
  });
}

function groupsFrom(
  value: unknown,
  fallback: readonly BackupGroup[],
): BackupGroup[] {
  if (value === undefined) return [...fallback];
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every((g) => typeof g === 'string' && isBackupGroup(g))
  ) {
    throw new ApiProblem(400, 'bad_request', 'Choose which groups to include.');
  }
  return value as BackupGroup[];
}

function passphraseFrom(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new ApiProblem(400, 'bad_request', 'Enter the backup passphrase.');
  }
  return value;
}

/**
 * Backup export and restore for the owner (docs/PLAN-backup.md §6). Everything needs
 * `backup.manage`. Passphrases only ever arrive in request bodies and are never logged or put
 * in the audit log.
 */
export function registerBackupRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
): void {
  const manager = () => {
    if (!deps.backup) {
      throw new ApiProblem(
        404,
        'not_found',
        'Backups are not set up on this bot.',
      );
    }
    return deps.backup;
  };
  const audit = (
    request: FastifyRequest,
    action: string,
    target: string | null,
    detailJson?: unknown,
  ) =>
    deps.adminStore.recordAuditLog({
      actorTelegramId: request.actor.telegramId,
      source: 'miniapp',
      action,
      target,
      detailJson,
    });

  const fileName = (raw: string): string => {
    if (!BACKUP_FILE_NAME.test(raw)) {
      throw new ApiProblem(404, 'not_found', 'There is no such backup file.');
    }
    return raw;
  };

  const sourcePath = (source: BackupSource | undefined): string => {
    const dir = manager().service.dir;
    if (source && 'file' in source) return join(dir, fileName(source.file));
    if (source && 'upload' in source && UPLOAD_ID.test(source.upload)) {
      return join(dir, `upload-${source.upload}.tmp`);
    }
    throw new ApiProblem(400, 'bad_request', 'Choose a backup to use.');
  };

  const missing = async (path: string) => {
    try {
      await stat(path);
    } catch {
      throw new ApiProblem(404, 'not_found', 'That backup file is gone.');
    }
  };

  app.get(
    '/backup',
    { config: { permission: 'backup.manage' } },
    async (): Promise<BackupStatusResponse> => {
      const m = manager();
      const files = await m.service.list();
      const admins = await deps.adminStore.listAdmins();
      return {
        groups: BACKUP_GROUPS.map((id) => ({
          id,
          tables: [...GROUP_TABLES[id]],
          default: DEFAULT_GROUPS.includes(id),
        })),
        schedule: await m.getSchedule(),
        passphraseSet: Boolean(await m.getPassphrase()),
        passphraseFromConfig: m.passphraseFromConfig(),
        lastRun: await m.getLastRun(),
        ownerChat: admins.some((admin) => admin.isOwner),
        files: files.map((file): BackupFileDto => ({
          name: file.name,
          bytes: file.bytes,
          modifiedAt: file.modifiedAt.toISOString(),
        })),
        dir: m.service.dir,
      };
    },
  );

  app.put(
    '/backup/schedule',
    { config: { permission: 'backup.manage', action: true } },
    async (
      request: FastifyRequest<{ Body: BackupSchedule }>,
    ): Promise<ActionResponse> => {
      const schedule = await userError(() =>
        manager().setSchedule(request.body),
      );
      await audit(request, 'backupschedule', null, schedule);
      return {
        message: schedule.enabled ? 'Schedule saved.' : 'Schedule is off.',
      };
    },
  );

  app.put(
    '/backup/passphrase',
    { config: { permission: 'backup.manage', action: true } },
    async (
      request: FastifyRequest<{ Body: BackupSetPassphraseRequest }>,
    ): Promise<ActionResponse> => {
      const value = request.body?.passphrase;
      if (value !== null && typeof value !== 'string') {
        throw new ApiProblem(400, 'bad_request', 'Enter a passphrase.');
      }
      await userError(() => manager().setPassphrase(value));
      // Never the passphrase itself.
      await audit(request, 'backuppassphrase', null, { set: value !== null });
      return {
        message:
          value === null ? 'Saved passphrase forgotten.' : 'Passphrase saved.',
      };
    },
  );

  app.post(
    '/backup/run',
    { config: { permission: 'backup.manage', action: true } },
    async (request): Promise<ActionResponse> => {
      const run = await manager().runNow();
      await audit(request, 'backuprun', null, { ok: run.ok });
      if (!run.ok) throw new ApiProblem(400, 'bad_request', run.message);
      return { message: run.message };
    },
  );

  // ── Files on the host ────────────────────────────────────────────────────────────────────

  app.post(
    '/backup/files',
    { config: { permission: 'backup.manage', action: true } },
    async (
      request: FastifyRequest<{ Body: CreateBackupRequest }>,
    ): Promise<BackupFileDto> => {
      const groups = groupsFrom(request.body?.groups, DEFAULT_GROUPS);
      const passphrase = passphraseFrom(request.body?.passphrase);
      const m = manager();
      const created = await userError(() =>
        m.exclusive(() =>
          m.service.createFile({ groups, passphrase, prefix: 'manual' }),
        ),
      );
      await audit(request, 'backupexport', created.name, {
        groups,
        bytes: created.bytes,
      });
      return {
        name: created.name,
        bytes: created.bytes,
        modifiedAt: new Date().toISOString(),
      };
    },
  );

  app.get(
    '/backup/files/:name',
    { config: { permission: 'backup.manage', action: true } },
    async (request: FastifyRequest<{ Params: { name: string } }>, reply) => {
      const name = fileName(request.params.name);
      const path = join(manager().service.dir, name);
      await missing(path);
      await audit(request, 'backupdownload', name);
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .send(createReadStream(path));
    },
  );

  app.post(
    '/backup/files/:name/send',
    { config: { permission: 'backup.manage', action: true } },
    async (
      request: FastifyRequest<{ Params: { name: string } }>,
    ): Promise<ActionResponse> => {
      const name = fileName(request.params.name);
      const path = join(manager().service.dir, name);
      await missing(path);
      if ((await stat(path)).size > TELEGRAM_LIMIT) {
        throw new ApiProblem(
          400,
          'bad_request',
          'That file is over Telegram’s 50 MB limit. Download it instead, or leave out the history group.',
        );
      }
      await manager().sender.sendDocument(
        request.actor.telegramId,
        path,
        `cod2admin backup ${name}\nEncrypted: restoring needs your backup passphrase.`,
      );
      await audit(request, 'backupsend', name);
      return { message: 'Sent to your chat with the bot.' };
    },
  );

  app.delete(
    '/backup/files/:name',
    { config: { permission: 'backup.manage', action: true } },
    async (
      request: FastifyRequest<{ Params: { name: string } }>,
    ): Promise<ActionResponse> => {
      const name = fileName(request.params.name);
      await rm(join(manager().service.dir, name), { force: true });
      await audit(request, 'backupdelete', name);
      return { message: 'Deleted.' };
    },
  );

  // ── Restore ──────────────────────────────────────────────────────────────────────────────

  // The body is the file itself, streamed to disk: it can be far past the JSON body limit.
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  );

  app.post(
    '/backup/uploads',
    {
      bodyLimit: MAX_UPLOAD_BYTES,
      config: { permission: 'backup.manage', action: true },
    },
    async (request): Promise<BackupUploadResponse> => {
      const dir = manager().service.dir;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = randomBytes(16).toString('hex');
      const path = join(dir, `upload-${id}.tmp`);
      let bytes = 0;
      try {
        await pipeline(
          request.body as NodeJS.ReadableStream,
          new Transform({
            transform(chunk: Buffer, _enc, callback) {
              bytes += chunk.length;
              if (bytes > MAX_UPLOAD_BYTES) {
                callback(
                  new ApiProblem(
                    413,
                    'too_large',
                    'That file is too big for a backup.',
                  ),
                );
              } else callback(null, chunk);
            },
          }),
          createWriteStream(path, { mode: 0o600 }),
        );
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
      if (!bytes) {
        await rm(path, { force: true });
        throw new ApiProblem(400, 'bad_request', 'The file is empty.');
      }
      return { upload: id, bytes };
    },
  );

  app.post(
    '/backup/preview',
    { config: { permission: 'backup.manage', action: true } },
    async (
      request: FastifyRequest<{ Body: BackupPreviewRequest }>,
    ): Promise<BackupPreviewResponse> => {
      const path = sourcePath(request.body?.source);
      await missing(path);
      const report = await userError(() =>
        manager().service.preview(
          path,
          passphraseFrom(request.body.passphrase),
        ),
      );
      return {
        created: report.created,
        app: report.app,
        groups: report.groups,
        tables: report.tables,
        warnings: report.warnings,
      };
    },
  );

  app.post(
    '/backup/restore',
    { config: { permission: 'backup.manage', action: true } },
    async (
      request: FastifyRequest<{ Body: BackupRestoreRequest }>,
    ): Promise<BackupRestoreResponse> => {
      if (request.body?.confirm !== 'REPLACE') {
        throw new ApiProblem(400, 'bad_request', 'Type REPLACE to confirm.');
      }
      const m = manager();
      const path = sourcePath(request.body.source);
      await missing(path);
      const passphrase = passphraseFrom(request.body.passphrase);
      const groups = request.body.groups
        ? groupsFrom(request.body.groups, [])
        : undefined;

      const snapshot = await userError(() =>
        m.exclusive(async () => {
          // Check the file and passphrase before touching anything.
          await m.service.preview(path, passphrase);
          // The way back: what is there now, saved first.
          const saved = await m.service.createFile({
            groups: [...BACKUP_GROUPS],
            passphrase,
            prefix: 'pre-import',
          });
          await m.service.restore(path, passphrase, groups);
          return saved.name;
        }),
      );
      if ('upload' in request.body.source) await rm(path, { force: true });
      // After the restore, so the row lands in the restored audit log.
      await audit(request, 'backuprestore', null, { groups, snapshot });
      m.restartSoon();
      return {
        message:
          'Restored. The bot restarts now to load the data; reopen the app in a minute.',
        restarting: true,
        snapshot,
      };
    },
  );
}
