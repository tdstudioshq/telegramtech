/**
 * Scheduler unit tests (§11): registration, per-job lock skip, crash isolation,
 * fresh correlation ids per run, run metrics, and graceful start/stop over the
 * interval timers (fake timers — never real sleeps).
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheProvider } from '../../../src/adapters/cache/memory-cache.provider.js';
import type { CacheProvider } from '../../../src/core/ports/cache-provider.port.js';
import { Scheduler, type Job, type JobRunSample } from '../../../src/jobs/scheduler.js';
import { createLogger } from '../../../src/logging/logger.js';
import { FakeClock } from '../../fakes/fake-clock.js';

const silentLogger = createLogger({ level: 'silent', name: 'test' });

const recordingMetrics = () => {
  const samples: JobRunSample[] = [];
  return { samples, record: (s: JobRunSample) => void samples.push(s) };
};

const makeScheduler = (cache: CacheProvider = new MemoryCacheProvider(new FakeClock())) => {
  const metrics = recordingMetrics();
  const scheduler = new Scheduler(cache, silentLogger, metrics);
  return { scheduler, metrics, cache };
};

const job = (name: string, run: Job['run'], overrides: Partial<Job> = {}): Job => ({
  name,
  intervalMs: 0,
  lockTtlSeconds: 30,
  run,
  ...overrides,
});

describe('Scheduler registration', () => {
  it('exposes registered job names in order', () => {
    const { scheduler } = makeScheduler();
    scheduler.register(job('a', async () => ({ processed: 0 })));
    scheduler.register(job('b', async () => ({ processed: 0 })));
    expect(scheduler.registered).toEqual(['a', 'b']);
  });

  it('rejects a duplicate job name', () => {
    const { scheduler } = makeScheduler();
    scheduler.register(job('dup', async () => ({ processed: 0 })));
    expect(() => scheduler.register(job('dup', async () => ({ processed: 0 })))).toThrow(
      /duplicate job registration/,
    );
  });
});

describe('Scheduler.trigger', () => {
  it('runs the job and records an ok sample with the processed count', async () => {
    const { scheduler, metrics } = makeScheduler();
    let ran = 0;
    const j = job('work', async () => {
      ran += 1;
      return { processed: 7, custom: 1 };
    });
    scheduler.register(j);

    await scheduler.trigger(j);

    expect(ran).toBe(1);
    expect(metrics.samples).toHaveLength(1);
    expect(metrics.samples[0]).toMatchObject({ job: 'work', outcome: 'ok', processed: 7 });
  });

  it('passes a fresh correlation id into each run', async () => {
    const { scheduler } = makeScheduler();
    const seen: string[] = [];
    const j = job('corr', async (ctx) => {
      seen.push(ctx.correlationId);
      return { processed: 0 };
    });
    scheduler.register(j);

    await scheduler.trigger(j);
    await scheduler.trigger(j);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]).not.toBe(seen[1]); // a new correlation id per run
  });

  it('skips the run when the per-job lock is already held (correctness independent)', async () => {
    const { scheduler, metrics } = makeScheduler();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const j = job(
      'locked',
      async () => {
        runs += 1;
        await gate;
        return { processed: 1 };
      },
      { lockTtlSeconds: 60 },
    );
    scheduler.register(j);

    const first = scheduler.trigger(j); // acquires the lock, parks on the gate
    await scheduler.trigger(j); // lock held → skipped without running
    expect(runs).toBe(1);
    expect(metrics.samples.at(-1)).toMatchObject({ job: 'locked', outcome: 'skipped' });

    release();
    await first;
    expect(runs).toBe(1);
  });

  it('isolates a throwing job — trigger resolves and records an error sample', async () => {
    const { scheduler, metrics } = makeScheduler();
    const boom = job('boom', async () => {
      throw new Error('kaboom');
    });
    let siblingRan = false;
    const sibling = job('sibling', async () => {
      siblingRan = true;
      return { processed: 0 };
    });
    scheduler.register(boom);
    scheduler.register(sibling);

    await expect(scheduler.trigger(boom)).resolves.toBeUndefined();
    await scheduler.trigger(sibling);

    expect(metrics.samples[0]).toMatchObject({ job: 'boom', outcome: 'error' });
    expect(siblingRan).toBe(true); // one job failing never stops the others
  });
});

describe('Scheduler start/stop', () => {
  it('fires on the interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler } = makeScheduler();
      let runs = 0;
      scheduler.register(
        job('tick', async () => ({ processed: (runs += 1) }), { intervalMs: 1000 }),
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(runs).toBe(3);

      await scheduler.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(runs).toBe(3); // no ticks after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it('never schedules a job with intervalMs <= 0 (e.g. the analytics stub)', async () => {
    vi.useFakeTimers();
    try {
      const { scheduler } = makeScheduler();
      let runs = 0;
      scheduler.register(job('unscheduled', async () => ({ processed: (runs += 1) })));

      scheduler.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toBe(0);

      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
