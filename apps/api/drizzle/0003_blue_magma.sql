ALTER TABLE "email_outbox" ADD COLUMN "from" text NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "from_name" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "body" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "next_try_at" timestamp with time zone;