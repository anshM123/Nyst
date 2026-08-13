/**
 * Minimal ambient types for `pg`.
 *
 * The driver ships no TypeScript declarations and is loaded dynamically, so a
 * deployment missing it fails at the entry point with a clear message rather
 * than at import time. Declaring only what the entry points actually use keeps
 * the surface honest: anything beyond this is a compile error rather than an
 * `any` nobody notices.
 */
declare module "pg" {
  export interface QueryResult { rows: Record<string, unknown>[] }
  export class Pool {
    constructor(options: { connectionString: string });
    query(sql: string, params?: readonly unknown[]): Promise<QueryResult>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
  export interface PoolClient {
    query(sql: string, params?: readonly unknown[]): Promise<QueryResult>;
    release(): void;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
