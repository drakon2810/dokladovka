import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { ServerConfig } from '../config.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  transaction<T>(operation: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

function normalizeResult<T>(result: { rows: T[]; rowCount?: number | null; affectedRows?: number }): QueryResult<T> {
  return {
    rows: result.rows,
    rowCount: result.rowCount ?? (result.rows.length > 0 ? result.rows.length : result.affectedRows ?? 0),
  };
}

export async function createDatabase(config: ServerConfig): Promise<Database> {
  if (config.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      statement_timeout: 30_000,
      application_name: 'dokladovka-api',
    });
    return {
      kind: 'postgres',
      async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
        return normalizeResult<T>(await pool.query<T>(sql, params));
      },
      async exec(sql: string) {
        await pool.query(sql);
      },
      async transaction<T>(operation: (tx: Queryable) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await operation({
            async query<R extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
              return normalizeResult<R>(await client.query<R>(sql, params));
            },
            async exec(sql: string) {
              await client.query(sql);
            },
          });
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      async close() {
        await pool.end();
      },
    };
  }

  await mkdir(dirname(config.pgliteDataDir), { recursive: true });
  const { PGlite } = await import('@electric-sql/pglite');
  const client = new PGlite(config.pgliteDataDir);
  await client.waitReady;
  return databaseFromPglite(client);
}

export function databaseFromPglite(client: PGlite): Database {
  return {
    kind: 'pglite',
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return normalizeResult<T>(await client.query<T>(sql, params));
    },
    async exec(sql: string) {
      await client.exec(sql);
    },
    async transaction<T>(operation: (tx: Queryable) => Promise<T>) {
      return client.transaction(async (transaction) => operation({
        async query<R extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
          return normalizeResult<R>(await transaction.query<R>(sql, params));
        },
        async exec(sql: string) {
          await transaction.exec(sql);
        },
      }));
    },
    async close() {
      await client.close();
    },
  };
}
