/**
 * Analytics handler — registered NO-OP stub (§9, §11). The registration slot
 * exists so future analytics (PurchaseCompleted counters, funnels) are added by
 * replacing this handler, not by editing services. Deliberately does nothing.
 */
import type { EventHandler } from '../dispatcher.js';

export const analyticsStub = (): EventHandler<'PurchaseCompleted'> => () => undefined;
