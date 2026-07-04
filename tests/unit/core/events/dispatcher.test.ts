import { describe, expect, it } from 'vitest';
import { EventBuffer, EventDispatcher } from '../../../../src/core/events/dispatcher.js';
import type {
  ContentUnlocked,
  DomainEvent,
  PurchaseCompleted,
} from '../../../../src/core/events/events.js';

const purchaseCompleted = (purchaseId: string): PurchaseCompleted => ({
  type: 'PurchaseCompleted',
  purchaseId,
  userId: 'user-1',
  creatorId: 'creator-1',
  dropId: 'drop-1',
  planId: null,
  amountStars: 50,
  occurredAt: new Date('2026-01-01T00:00:00Z'),
});

const contentUnlocked = (): ContentUnlocked => ({
  type: 'ContentUnlocked',
  userId: 'user-1',
  creatorId: 'creator-1',
  dropId: 'drop-1',
  occurredAt: new Date('2026-01-01T00:00:01Z'),
});

const silentLogger = { error: () => undefined };

const collectingLogger = () => {
  const entries: { context: Record<string, unknown>; message: string }[] = [];
  return {
    entries,
    error(context: Record<string, unknown>, message: string) {
      entries.push({ context, message });
    },
  };
};

describe('EventDispatcher', () => {
  it('dispatches an event to its registered handlers with the typed payload', async () => {
    const dispatcher = new EventDispatcher(silentLogger);
    const seen: string[] = [];
    dispatcher.register('PurchaseCompleted', 'test', (event) => {
      seen.push(event.purchaseId);
    });

    await dispatcher.dispatch(purchaseCompleted('p-1'));

    expect(seen).toEqual(['p-1']);
  });

  it('runs handlers for the same event in registration order', async () => {
    const dispatcher = new EventDispatcher(silentLogger);
    const order: string[] = [];
    dispatcher.register('PurchaseCompleted', 'first', () => {
      order.push('first');
    });
    dispatcher.register('PurchaseCompleted', 'second', async () => {
      order.push('second');
    });

    await dispatcher.dispatch(purchaseCompleted('p-1'));

    expect(order).toEqual(['first', 'second']);
  });

  it('ignores events with no registered handlers', async () => {
    const dispatcher = new EventDispatcher(silentLogger);
    await expect(dispatcher.dispatch(contentUnlocked())).resolves.toBeUndefined();
  });

  it('isolates a throwing handler: it is logged and siblings still run (ADR-010)', async () => {
    const logger = collectingLogger();
    const dispatcher = new EventDispatcher(logger);
    const order: string[] = [];
    dispatcher.register('PurchaseCompleted', 'boom', () => {
      throw new Error('handler exploded');
    });
    dispatcher.register('PurchaseCompleted', 'survivor', () => {
      order.push('survivor');
    });

    await expect(dispatcher.dispatch(purchaseCompleted('p-1'))).resolves.toBeUndefined();

    expect(order).toEqual(['survivor']);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.context['handler']).toBe('boom');
    expect(logger.entries[0]?.context['event']).toBe('PurchaseCompleted');
  });

  it('isolates a rejecting async handler the same way', async () => {
    const logger = collectingLogger();
    const dispatcher = new EventDispatcher(logger);
    dispatcher.register('ContentUnlocked', 'async-boom', async () => {
      throw new Error('async explosion');
    });

    await expect(dispatcher.dispatch(contentUnlocked())).resolves.toBeUndefined();
    expect(logger.entries).toHaveLength(1);
  });
});

describe('after-commit contract (EventBuffer + dispatchAll)', () => {
  it('runs no handlers while events are only raised (pre-commit)', () => {
    const dispatcher = new EventDispatcher(silentLogger);
    let calls = 0;
    dispatcher.register('PurchaseCompleted', 'counter', () => {
      calls += 1;
    });

    const buffer = new EventBuffer();
    buffer.raise(purchaseCompleted('p-1'));
    buffer.raise(purchaseCompleted('p-2'));

    expect(calls).toBe(0);
    expect(buffer.size).toBe(2);
  });

  it('dispatches drained events in raise order after commit', async () => {
    const dispatcher = new EventDispatcher(silentLogger);
    const order: string[] = [];
    dispatcher.register('PurchaseCompleted', 'trace', (event) => {
      order.push(event.purchaseId);
    });
    dispatcher.register('ContentUnlocked', 'trace', (event) => {
      order.push(`unlocked:${event.dropId}`);
    });

    const buffer = new EventBuffer();
    buffer.raise(purchaseCompleted('p-1'));
    buffer.raise(contentUnlocked());
    buffer.raise(purchaseCompleted('p-2'));

    // ...transaction commits here...
    await dispatcher.dispatchAll(buffer.drain());

    expect(order).toEqual(['p-1', 'unlocked:drop-1', 'p-2']);
  });

  it('a handler failure never breaks the dispatch of subsequent events', async () => {
    const logger = collectingLogger();
    const dispatcher = new EventDispatcher(logger);
    const delivered: string[] = [];
    dispatcher.register('PurchaseCompleted', 'boom', (event) => {
      if (event.purchaseId === 'p-1') throw new Error('first event handler failed');
      delivered.push(event.purchaseId);
    });

    await dispatcher.dispatchAll([purchaseCompleted('p-1'), purchaseCompleted('p-2')]);

    expect(delivered).toEqual(['p-2']);
    expect(logger.entries).toHaveLength(1);
  });

  it('drain empties the buffer so a second drain dispatches nothing (rollback = never drain)', () => {
    const buffer = new EventBuffer();
    buffer.raise(purchaseCompleted('p-1'));

    const first: DomainEvent[] = buffer.drain();
    const second: DomainEvent[] = buffer.drain();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(buffer.size).toBe(0);
  });
});
