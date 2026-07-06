CREATE INDEX "creators_discoverable_idx" ON "creators" USING btree ("is_featured","created_at") WHERE "creators"."status" = 'active' and "creators"."slug" is not null and "creators"."onboarding_completed_at" is not null;--> statement-breakpoint
CREATE INDEX "creators_category_idx" ON "creators" USING btree ("category") WHERE "creators"."status" = 'active' and "creators"."slug" is not null and "creators"."onboarding_completed_at" is not null and "creators"."category" is not null;--> statement-breakpoint
CREATE INDEX "payments_stale_pending_idx" ON "payments" USING btree ("created_at") WHERE "payments"."status" = 'pending';--> statement-breakpoint
-- pg_trgm GIN indexes (M7.3.1): serve the marketplace ILIKE search on display_name/slug.
-- Hand-added because Drizzle does not manage extensions; kept out of the Drizzle schema
-- snapshot deliberately, so they are maintained here (DATABASE.md §2).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creators_display_name_trgm_idx" ON "creators" USING gin ("display_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creators_slug_trgm_idx" ON "creators" USING gin ("slug" gin_trgm_ops);