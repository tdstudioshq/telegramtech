/**
 * AuditService — every money/access mutation writes its row IN THE SAME
 * TRANSACTION as the mutation (golden rule; DATABASE.md §10). Callers pass the
 * tx-bound Repositories, so a rolled-back transaction takes its audit rows with it.
 *
 * `action`/`entity_type` are varchar in the schema by design; the closed
 * vocabulary lives here as Zod enums (ADR-013) so free-text drift cannot occur.
 * The `event.*` actions are the post-commit ENRICHMENT namespace (§10: handlers
 * may append enrichment rows; the core row is never event-driven).
 */
import { z } from 'zod';
import type { Repositories } from '../repositories/index.js';

export const AUDIT_ACTIONS = [
  'user.registered',
  'payment.succeeded',
  'payment.failed',
  'purchase.completed',
  'purchase.failed',
  'subscription.activated',
  'subscription.expired',
  'subscription.renewed',
  'plan.created',
  'grant.created',
  'grant.revoked',
  // M7.1 dashboard/API creator-config actions (actor 'system' until creator/admin actors land in M7.6)
  'creator.registered',
  'creator.updated',
  'content.delivered',
  'content.uploaded',
  // post-commit enrichment rows appended by event handlers (never the core row)
  'event.purchase_completed',
  'event.content_unlocked',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = [
  'user',
  'creator',
  'drop',
  'drop_asset',
  'subscription_plan',
  'subscription',
  'purchase',
  'payment',
  'access_grant',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

const auditInputSchema = z
  .object({
    creatorId: z.uuid().nullable(),
    action: z.enum(AUDIT_ACTIONS),
    entityType: z.enum(AUDIT_ENTITY_TYPES),
    entityId: z.uuid(),
    actorType: z.enum(['user', 'system', 'job']),
    actorUserId: z.uuid().nullish(),
    correlationId: z.string().nullish(),
    context: z.unknown().optional(),
  })
  // mirrors the DB CHECK: user actions always name the user; system/job never do
  .refine((entry) => (entry.actorType === 'user') === (entry.actorUserId != null), {
    message: 'actor_user_id must be set iff actor_type is user',
  });

export type AuditInput = z.input<typeof auditInputSchema>;

export class AuditService {
  /** Throws on vocabulary violations — a bad audit entry is a bug, not an expected failure. */
  async record(repos: Repositories, input: AuditInput): Promise<void> {
    const entry = auditInputSchema.parse(input);
    await repos.audit.append(entry);
  }
}
