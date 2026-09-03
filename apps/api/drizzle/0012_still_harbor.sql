ALTER TABLE "tickets" ADD COLUMN "hold_on" text;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "hold_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "hold_warned_at" timestamp with time zone;
