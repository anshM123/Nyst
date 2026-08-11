/**
 * Minimal ambient declaration for the optional `pg` peer dependency, loaded
 * dynamically by PostgresStore. When `pg` is actually installed, its own
 * richer types take precedence in downstream projects.
 */
declare module "pg" {
  export interface QueryResult {
    rows: Record<string, unknown>[];
  }
  export class Pool {
    constructor(config: { connectionString: string });
    query(sql: string, params?: unknown[]): Promise<QueryResult>;
    end(): Promise<void>;
  }
}
