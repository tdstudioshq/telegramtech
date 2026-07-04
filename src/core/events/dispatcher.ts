/**
 * In-process, synchronous, after-commit event dispatcher (ADR-010).
 *
 * Contract:
 * - Services raise events into an EventBuffer during a transaction; the buffer is
 *   drained into `dispatchAll` only after the transaction commits. A failed
 *   transaction must never have emitted side effects.
 * - Handlers are isolated: a throwing handler is logged and never fails the
 *   originating request or blocks sibling handlers.
 * - Handlers run sequentially in registration order; events dispatch in raise order.
 * - Registration happens in the composition root (app.ts) so wiring stays visible.
 *
 * This is a seam — if we ever outgrow in-process, the interface stays and the
 * transport changes (outbox table, per debt #6).
 */
import type { DomainEvent, DomainEventType, EventOfType } from './events.js';

/** Minimal logging surface so core stays free of adapter/logging imports (rule 1). */
export interface DispatcherLogger {
  error(context: Record<string, unknown>, message: string): void;
}

export type EventHandler<T extends DomainEventType = DomainEventType> = (
  event: EventOfType<T>,
) => void | Promise<void>;

/** Internal type-erased shape — safety holds because register() keys handlers by their event type. */
type AnyHandler = (event: DomainEvent) => void | Promise<void>;

interface Registration {
  readonly name: string;
  readonly handler: AnyHandler;
}

export class EventDispatcher {
  private readonly handlers = new Map<DomainEventType, Registration[]>();

  constructor(private readonly logger: DispatcherLogger) {}

  register<T extends DomainEventType>(type: T, name: string, handler: EventHandler<T>): void {
    const registrations = this.handlers.get(type) ?? [];
    registrations.push({ name, handler: handler as unknown as AnyHandler });
    this.handlers.set(type, registrations);
  }

  /** Dispatch one event to all its handlers. Never throws — handler failures are logged. */
  async dispatch(event: DomainEvent): Promise<void> {
    const registrations = this.handlers.get(event.type) ?? [];
    for (const { name, handler } of registrations) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.error(
          { event: event.type, handler: name, err: error },
          'event handler failed (isolated — request unaffected)',
        );
      }
    }
  }

  /** Dispatch events in order — call only after the surrounding transaction committed. */
  async dispatchAll(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      await this.dispatch(event);
    }
  }
}

/**
 * Per-transaction event buffer. Services raise into it during the transaction;
 * the caller drains it into `dispatchAll` strictly after commit. On rollback,
 * simply never drain — the events die with the transaction.
 */
export class EventBuffer {
  private events: DomainEvent[] = [];

  raise(event: DomainEvent): void {
    this.events.push(event);
  }

  get size(): number {
    return this.events.length;
  }

  /** Returns raised events in raise order and empties the buffer. */
  drain(): DomainEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }
}
