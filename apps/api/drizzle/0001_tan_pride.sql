ALTER TABLE "users" ADD COLUMN "theme" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "color_mode" text DEFAULT 'system' NOT NULL;