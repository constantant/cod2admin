import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, MODERATOR_PERMISSIONS } from './permissions.js';

const sql = readFileSync(
  fileURLToPath(new URL('../../drizzle/0006_permissions.sql', import.meta.url)),
  'utf8',
);

function valuesBlock(role: 'moderator' | 'admin'): string[] {
  const marker = `WHERE "admins"."role" = '${role}'`;
  const end = sql.indexOf(marker);
  const start = sql.lastIndexOf('CROSS JOIN (VALUES', end);
  const block = sql.slice(start, end);
  return [...block.matchAll(/\('([^']+)'\)/g)].map((match) => match[1] ?? '');
}

describe('0006_permissions', () => {
  it('backfills the owner and both seeds before it drops the role column', () => {
    const drop = sql.indexOf('DROP COLUMN "role"');
    expect(sql.indexOf(`SET "is_owner" = true WHERE "role" = 'owner'`)).toBeLessThan(
      drop,
    );
    expect(sql.indexOf(`WHERE "admins"."role" = 'moderator'`)).toBeLessThan(drop);
    expect(sql.indexOf(`WHERE "admins"."role" = 'admin'`)).toBeLessThan(drop);
    expect(sql.indexOf('DROP TYPE "public"."admin_role"')).toBeGreaterThan(drop);
  });

  it('seeds a moderator and an admin with the catalog templates, and skips the owner', () => {
    expect(valuesBlock('moderator')).toEqual([...MODERATOR_PERMISSIONS]);
    expect(valuesBlock('admin')).toEqual([...ADMIN_PERMISSIONS]);
    expect(sql).toContain(`WHERE "admins"."role" = 'moderator'`);
    expect(sql).toContain(`WHERE "admins"."role" = 'admin'`);
    expect(sql).not.toContain(`WHERE "admins"."role" = 'owner'`);
  });

  it('recreates the single-owner index on is_owner', () => {
    expect(sql.indexOf('DROP INDEX "admins_one_owner_idx"')).toBeLessThan(
      sql.indexOf('CREATE UNIQUE INDEX "admins_one_owner_idx"'),
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "admins_one_owner_idx" ON "admins" USING btree ("is_owner") WHERE "admins"."is_owner" = true',
    );
  });
});
