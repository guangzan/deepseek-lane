import { describe, it, expect } from "vite-plus/test";
import { ConcurrencyLimiter, ConcurrencyLimitTimeoutError } from "../concurrency.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ConcurrencyLimiter", () => {
  it("grants slots immediately up to the limit", async () => {
    const limiter = new ConcurrencyLimiter(2);

    const first = await limiter.acquire();
    const second = await limiter.acquire();

    expect(limiter.activeCount).toBe(2);
    expect(limiter.waitingCount).toBe(0);

    first();
    second();
    expect(limiter.activeCount).toBe(0);
  });

  it("queues requests beyond the limit until a slot is released", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();

    let granted = false;
    const queued = limiter.acquire().then((releaseQueued) => {
      granted = true;
      return releaseQueued;
    });
    await tick();

    expect(granted).toBe(false);
    expect(limiter.waitingCount).toBe(1);

    release();
    const releaseQueued = await queued;

    expect(granted).toBe(true);
    expect(limiter.waitingCount).toBe(0);
    expect(limiter.activeCount).toBe(1);

    releaseQueued();
    expect(limiter.activeCount).toBe(0);
  });

  it("hands freed slots to waiters in arrival order", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const releaseFirst = await limiter.acquire();
    const order: string[] = [];

    const second = limiter.acquire().then((release) => {
      order.push("second");
      return release;
    });
    const third = limiter.acquire().then((release) => {
      order.push("third");
      return release;
    });
    await tick();

    releaseFirst();
    (await second)();
    (await third)();

    expect(order).toEqual(["second", "third"]);
  });

  it("ignores repeated releases of the same slot", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();

    let secondGranted = false;
    const second = limiter.acquire().then((releaseSecond) => {
      secondGranted = true;
      return releaseSecond;
    });
    await tick();

    release();
    release();
    const releaseSecond = await second;

    expect(secondGranted).toBe(true);
    expect(limiter.activeCount).toBe(1);

    releaseSecond();
    expect(limiter.activeCount).toBe(0);
  });

  it("does not limit anything when the limit is zero", async () => {
    const limiter = new ConcurrencyLimiter(0);

    const releases = await Promise.all([1, 2, 3, 4, 5].map(() => limiter.acquire()));

    expect(releases).toHaveLength(5);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.waitingCount).toBe(0);
    for (const release of releases) release();
    expect(limiter.activeCount).toBe(0);
  });

  it("gives up waiting once the timeout expires", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();

    await expect(limiter.acquire(10)).rejects.toBeInstanceOf(ConcurrencyLimitTimeoutError);
    expect(limiter.waitingCount).toBe(0);

    release();
    expect(limiter.activeCount).toBe(0);

    const releaseAfterTimeout = await limiter.acquire();
    expect(limiter.activeCount).toBe(1);
    releaseAfterTimeout();
  });
});
