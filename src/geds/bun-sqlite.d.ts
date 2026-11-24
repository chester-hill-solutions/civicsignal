declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string, options?: { create?: boolean; readwrite?: boolean });
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
    close(): void;
  }
}
