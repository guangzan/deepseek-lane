// Limits how many upstream requests this proxy keeps in flight at once.
//
// Cursor issues many parallel requests (multiple chat tabs, agent tool loops).
// DeepSeek rejects the excess with a server-side error, so requests beyond the
// limit wait for a free slot instead of racing the upstream. A limit of 0
// keeps the previous behavior and never queues.

export class ConcurrencyLimitTimeoutError extends Error {
  readonly waitedMs: number;

  constructor(waitedMs: number) {
    super(`timed out after ${waitedMs}ms waiting for a free concurrency slot`);
    this.name = "ConcurrencyLimitTimeoutError";
    this.waitedMs = waitedMs;
  }
}

interface Waiter {
  grant: () => void;
  fail: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export class ConcurrencyLimiter {
  private readonly max: number;
  private active = 0;
  private waiting: Waiter[] = [];

  constructor(max: number) {
    this.max = Number.isFinite(max) ? Math.floor(max) : 0;
  }

  get limit(): number {
    return this.max;
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  // Resolves with a release function once a slot is available. Passing a
  // timeout of 0 (or a non-positive value) waits indefinitely. The release
  // function is idempotent, so callers can release from several paths.
  async acquire(timeoutMs = 0): Promise<() => void> {
    if (this.max <= 0) return () => {};
    if (this.active < this.max && this.waiting.length === 0) {
      this.active++;
      return this.createRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          this.active++;
          resolve(this.createRelease());
        },
        fail: (err: Error) => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(err);
        },
        timer: null,
        settled: false,
      };

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index !== -1) this.waiting.splice(index, 1);
          waiter.fail(new ConcurrencyLimitTimeoutError(timeoutMs));
        }, timeoutMs);
        // Do not keep the process alive just for a queued wait.
        waiter.timer.unref?.();
      }

      this.waiting.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(this.active - 1, 0);
      const next = this.waiting.shift();
      if (next) next.grant();
    };
  }
}
