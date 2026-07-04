/**
 * Clock port — the only way core reads time. Tests inject FakeClock;
 * expiration logic never sleeps (testing strategy, CLAUDE.md).
 */
export interface Clock {
  now(): Date;
}
