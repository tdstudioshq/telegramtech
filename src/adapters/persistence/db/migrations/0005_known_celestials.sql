-- M7.3.1: tighten the "one active subscription" invariant from per-(user,plan) to
-- per-(user,creator) — the entitlement grain (ADR-011). The new UNIQUE INDEX will FAIL
-- to build if any (user_id, creator_id) already has >1 active subscription (only possible
-- if a creator had multiple plans AND a user held concurrent active subs before this).
-- PRE-APPLY CHECK (owner action): this must return zero rows before applying to a
-- populated database —
--   SELECT user_id, creator_id, count(*) FROM subscriptions WHERE status='active'
--   GROUP BY user_id, creator_id HAVING count(*) > 1;
-- If it returns rows, demote all but the latest expires_at to 'expired' first.
DROP INDEX "subscriptions_one_active_per_plan_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_active_per_creator_uq" ON "subscriptions" USING btree ("user_id","creator_id") WHERE "subscriptions"."status" = 'active';