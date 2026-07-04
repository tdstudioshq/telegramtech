/**
 * DATABASE.md rev 2.2 §10 — append-only ledger. Core rows are written in the same
 * transaction as the mutation (golden rule 4); AuditRepository exposes append/find*
 * only, never update/delete. action/entity_type are varchar, NOT enums — vocabulary
 * is Zod-validated in the application layer so new verbs need no migration.
 * BRIN on created_at is documented as "at volume" — deliberately not in the MVP migration.
 */
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { auditActorTypeEnum } from './enums.js';
import { creators } from './creators.js';
import { users } from './users.js';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL = platform-level event (e.g. user.registered)
    creatorId: uuid('creator_id').references(() => creators.id),
    action: varchar('action', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    // polymorphic across entity_type — no FK by design; integrity via same-tx writes
    entityId: uuid('entity_id').notNull(),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    correlationId: text('correlation_id'),
    context: jsonb('context'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_creator_created_idx').on(t.creatorId, t.createdAt),
    // user actions always name the user; system/job actions never do
    check(
      'audit_logs_actor_user_presence',
      sql`(${t.actorType} = 'user') = (${t.actorUserId} IS NOT NULL)`,
    ),
  ],
);
