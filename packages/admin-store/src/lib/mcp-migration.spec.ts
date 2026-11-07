import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  fileURLToPath(new URL('../../drizzle/0007_mcp.sql', import.meta.url)),
  'utf8',
);

describe('0007_mcp', () => {
  it('adds the mcp audit source in its own statement, before the tables', () => {
    const add = sql.indexOf(`ADD VALUE 'mcp'`);
    const tables = sql.indexOf('CREATE TABLE "mcp_pending"');
    const breakpoint = sql.indexOf('--> statement-breakpoint');

    expect(add).toBeGreaterThan(-1);
    expect(breakpoint).toBeGreaterThan(add);
    expect(tables).toBeGreaterThan(breakpoint);
  });

  it('deletes codes and grants when the staff member is removed', () => {
    expect(sql).toContain(
      'CONSTRAINT "mcp_codes_telegram_id_admins_telegram_id_fk" FOREIGN KEY ("telegram_id") REFERENCES "public"."admins"("telegram_id") ON DELETE cascade ON UPDATE no action',
    );
    expect(sql).toContain(
      'CONSTRAINT "mcp_grants_telegram_id_admins_telegram_id_fk" FOREIGN KEY ("telegram_id") REFERENCES "public"."admins"("telegram_id") ON DELETE cascade ON UPDATE no action',
    );
  });

  it('cascades retired refresh tokens and access tokens from the grant', () => {
    expect(sql).toContain(
      'FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE cascade ON UPDATE no action',
    );
    expect(sql.match(/REFERENCES "public"\."mcp_grants"\("id"\) ON DELETE cascade/g)).toHaveLength(
      2,
    );
  });
});
