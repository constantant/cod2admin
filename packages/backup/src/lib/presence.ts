import type { Pool, PoolClient } from 'pg';

const KEY_SQL = `hashtext('cod2admin-gateway')`;

/**
 * A running gateway keeps a shared advisory lock on a connection of its own, which costs nothing
 * (shared locks never block each other). The CLI asks for the exclusive one: if it cannot get it,
 * a gateway is running and a restore would race its in-memory state.
 */
export async function holdGatewayPresence(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query(`SELECT pg_advisory_lock_shared(${KEY_SQL})`);
  return client;
}

export async function isGatewayRunning(pool: Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(${KEY_SQL}) AS ok`,
    );
    if (rows[0].ok) {
      await client.query(`SELECT pg_advisory_unlock(${KEY_SQL})`);
      return false;
    }
    return true;
  } finally {
    client.release();
  }
}

export { Pool } from 'pg';
