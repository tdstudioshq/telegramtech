/**
 * Drizzle unit of work (ADR-009/ADR-010): runs `fn` inside one DB transaction with
 * transaction-bound repositories and a fresh EventBuffer. Events dispatch strictly
 * AFTER commit; if `fn` throws, the transaction rolls back and the buffer is never
 * drained — a failed transaction must never emit side effects.
 */
import { EventBuffer, type EventDispatcher } from '../../../core/events/dispatcher.js';
import type { Repositories, UnitOfWork } from '../../../core/repositories/index.js';
import { buildRepositories } from '../repositories/repositories.js';
import type { DbClient } from './client.js';

export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(
    private readonly db: DbClient,
    private readonly dispatcher: EventDispatcher,
  ) {}

  async run<T>(fn: (repos: Repositories, events: EventBuffer) => Promise<T>): Promise<T> {
    const events = new EventBuffer();
    const result = await this.db.transaction(async (tx) => fn(buildRepositories(tx), events));
    // reached only after COMMIT — dispatch never fails the request (handlers are isolated)
    await this.dispatcher.dispatchAll(events.drain());
    return result;
  }
}
