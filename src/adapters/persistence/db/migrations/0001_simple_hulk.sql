ALTER TABLE "creators" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_slug_unique" UNIQUE("slug");