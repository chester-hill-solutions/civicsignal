/** The durable checkpoint used by the pipeline coordinator. Unlike a lease,
 * this never grants a second writer because elapsed time passed. The runtime
 * owns one object instance; its alarm resumes pending work after a restart. */
export interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface CoordinatorStatus {
  pending: boolean;
  failures: number;
  lastError?: string;
}
export class DurableSingleFlight<T extends { remaining?: boolean }> {
  private running: Promise<T> | null = null;
  private initialized: Promise<void> | null = null;
  private exclusiveTail: Promise<void> = Promise.resolve();
  constructor(private readonly storage: CoordinatorStorage, private readonly work: () => Promise<T>,
    private readonly now: () => number = Date.now) {}

  initialize(): Promise<void> {
    this.initialized ??= (async () => {
      const state = await this.storage.get<CoordinatorStatus>('status');
      if (state?.pending && await this.storage.getAlarm() === null) await this.storage.setAlarm(this.now() + 1000);
    })();
    return this.initialized;
  }

  async run(): Promise<T> {
    if (this.running) return this.running;
    const task = this.exclusive(() => this.execute());
    this.running = task;
    try { return await task; }
    finally { if (this.running === task) this.running = null; }
  }

  /** Administrative vector reads share the writer queue. A request lost on
   * restart is retried by its caller; immutable artifacts make that safe. */
  async exclusive<R>(work: () => Promise<R>): Promise<R> {
    const previous = this.exclusiveTail;
    let release!: () => void;
    this.exclusiveTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }

  private async execute(): Promise<T> {
    await this.initialize();
    const previous = await this.storage.get<CoordinatorStatus>('status');
    await this.storage.put('status', { pending: true, failures: previous?.failures ?? 0 });
    // Persist recovery before external I/O. An alarm firing during a long
    // encoder call joins this Promise; it cannot launch another writer.
    await this.storage.setAlarm(this.now() + 5 * 60_000);
    try {
      const result = await this.work();
      await this.storage.put('status', { pending: !!result.remaining, failures: 0 });
      if (result.remaining) await this.storage.setAlarm(this.now() + 1000);
      else await this.storage.deleteAlarm();
      return result;
    } catch (error) {
      const failures = (previous?.failures ?? 0) + 1;
      await this.storage.put('status', { pending: true, failures, lastError: String(error).slice(0, 500) });
      await this.storage.setAlarm(this.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 7)));
      throw error;
    }
  }

  async alarm(): Promise<void> {
    await this.initialize();
    if (!(await this.storage.get<CoordinatorStatus>('status'))?.pending) return;
    if (this.running) {
      // The watchdog must not consume the only durable wakeup while joining a
      // long manual/cron request. Keep it armed without starting another job.
      await this.storage.setAlarm(this.now() + 5 * 60_000);
      return;
    }
    try { await this.run(); }
    catch { /* execute persisted the next bounded retry and its error. */ }
  }
}
