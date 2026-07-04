/**
 * FakeUnitOfWork — same contract as DrizzleUnitOfWork (ADR-009/010) over the
 * MemoryStore: rollback on throw (snapshot/restore), events dispatched strictly
 * after "commit", never on rollback. `dispatchedEvents` records what actually
 * dispatched so tests can assert after-commit behavior.
 */
import { EventBuffer, type EventDispatcher } from '../../src/core/events/dispatcher.js';
import type { DomainEvent } from '../../src/core/events/events.js';
import type { Repositories, UnitOfWork } from '../../src/core/repositories/index.js';
import type { MemoryStore } from './memory-repositories.js';

export class FakeUnitOfWork implements UnitOfWork {
  readonly dispatchedEvents: DomainEvent[] = [];

  constructor(
    private readonly store: MemoryStore,
    private readonly dispatcher: EventDispatcher,
  ) {}

  async run<T>(fn: (repos: Repositories, events: EventBuffer) => Promise<T>): Promise<T> {
    const events = new EventBuffer();
    const snapshot = this.store.snapshot();
    let result: T;
    try {
      result = await fn(this.store.repos, events);
    } catch (error) {
      this.store.restore(snapshot); // rollback — buffered events die with the tx
      throw error;
    }
    const drained = events.drain();
    this.dispatchedEvents.push(...drained);
    await this.dispatcher.dispatchAll(drained);
    return result;
  }
}
