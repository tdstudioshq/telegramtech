/**
 * Job scheduler (SYSTEM_ARCHITECTURE §11). Runs registered jobs on intervals with:
 *  - a per-job advisory cache lock (skip if already held) — correctness NEVER
 *    depends on the lock; the jobs are idempotent and safe to double-run (debt #5),
 *  - crash isolation — one job throwing never stops the scheduler or its siblings,
 *  - structured run logs (job, correlationId, duration, processed count),
 *  - a fresh correlation id per run, propagated into the job (→ services → audit),
 *  - a metrics hook seam (default no-op) for a future StatsD/Prometheus adapter,
 *  - graceful start/stop — stop() clears the timers and awaits in-flight runs.
 *
 * Jobs contain NO business logic — they call core services/engines (§11, rule 4).
 * This lives in the composition zone (`jobs/`): it may import core ports and the
 * logger, never adapters (boundary rule 4).
 */
import { randomUUID } from 'node:crypto';
import type { CacheProvider } from '../core/ports/cache-provider.port.js';
import type { Logger } from '../logging/logger.js';

/**
 * Metrics sink that emits one structured line per job run (M6 monitoring hook).
 * Machine-parseable (`metric: 'job.run'`) so a log drain can chart job throughput
 * and failures without a metrics backend yet — swap for StatsD/Prometheus later.
 */
export const loggingJobMetrics = (logger: Logger): JobMetrics => ({
  record: (sample) => logger.info({ metric: 'job.run', ...sample }, 'job metric'),
});

/** A job's per-run result. `processed` is the headline count for run logs/metrics. */
export interface JobRunStats {
  readonly processed: number;
  /** Job-specific counters (e.g. expired, sent, blocked) surface in the run log. */
  readonly [metric: string]: number;
}

/** Everything a job run receives — its correlation id and a child logger bound to it. */
export interface JobContext {
  readonly correlationId: string;
  readonly logger: Logger;
}

export interface Job {
  readonly name: string;
  /** Interval in ms. `<= 0` → registered but NOT scheduled (e.g. the analytics stub, §11). */
  readonly intervalMs: number;
  /** Advisory lock TTL (seconds). Auto-expires so a crashed run never wedges the lock. */
  readonly lockTtlSeconds: number;
  run(ctx: JobContext): Promise<JobRunStats>;
}

export type JobOutcome = 'ok' | 'skipped' | 'error';

/** One sample per attempted run — the metrics seam future adapters consume. */
export interface JobRunSample {
  readonly job: string;
  readonly correlationId: string;
  readonly outcome: JobOutcome;
  readonly durationMs: number;
  readonly processed: number;
}

export interface JobMetrics {
  record(sample: JobRunSample): void;
}

/** Default metrics sink — the run logs already carry the numbers (debt: real metrics later). */
export const noopMetrics: JobMetrics = { record: () => undefined };

export class Scheduler {
  private readonly jobs: Job[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlight = new Set<Promise<void>>();
  private running = false;

  constructor(
    private readonly cache: CacheProvider,
    private readonly logger: Logger,
    private readonly metrics: JobMetrics = noopMetrics,
  ) {}

  register(job: Job): void {
    if (this.jobs.some((j) => j.name === job.name)) {
      throw new Error(`duplicate job registration: ${job.name}`);
    }
    this.jobs.push(job);
  }

  /** Names in registration order — lets tests/ops assert what got wired. */
  get registered(): readonly string[] {
    return this.jobs.map((j) => j.name);
  }

  /** Arms the interval timers. Non-blocking; jobs with intervalMs <= 0 are left unscheduled. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const job of this.jobs) {
      if (job.intervalMs <= 0) {
        this.logger.info({ job: job.name }, 'job registered (no interval — not scheduled)');
        continue;
      }
      const timer = setInterval(() => void this.trigger(job), job.intervalMs);
      // don't keep the process alive solely for job timers; the client transport does that
      timer.unref?.();
      this.timers.set(job.name, timer);
      this.logger.info({ job: job.name, intervalMs: job.intervalMs }, 'job scheduled');
    }
  }

  /**
   * Run one job now, honoring its lock and isolation. Public so tests (and future
   * manual/ops triggers) can drive a single run without waiting for a tick.
   */
  async trigger(job: Job): Promise<void> {
    const run = this.runGuarded(job);
    this.inFlight.add(run);
    try {
      await run;
    } finally {
      this.inFlight.delete(run);
    }
  }

  private async runGuarded(job: Job): Promise<void> {
    const correlationId = randomUUID();
    const logger = this.logger.child({ job: job.name, correlationId });
    const startedAtMs = Date.now();
    try {
      const outcome = await this.cache.withLock(`job:${job.name}`, job.lockTtlSeconds, () =>
        job.run({ correlationId, logger }),
      );
      const durationMs = Date.now() - startedAtMs;
      if (outcome.skipped) {
        logger.debug({ durationMs }, 'job skipped — lock held by another run');
        this.emit(job.name, correlationId, 'skipped', durationMs, 0);
        return;
      }
      logger.info({ durationMs, ...outcome.result }, 'job completed');
      this.emit(job.name, correlationId, 'ok', durationMs, outcome.result.processed);
    } catch (error) {
      // crash isolation: a failing job never stops the scheduler or its siblings
      const durationMs = Date.now() - startedAtMs;
      logger.error({ err: error, durationMs }, 'job failed (isolated — scheduler continues)');
      this.emit(job.name, correlationId, 'error', durationMs, 0);
    }
  }

  private emit(
    job: string,
    correlationId: string,
    outcome: JobOutcome,
    durationMs: number,
    processed: number,
  ): void {
    this.metrics.record({ job, correlationId, outcome, durationMs, processed });
  }

  /** Clears the timers and awaits any in-flight runs so a shutdown never severs a transaction. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
      this.timers.delete(name);
    }
    await Promise.allSettled(this.inFlight);
  }
}
