CREATE TABLE "webhooks" (
"id" text PRIMARY KEY NOT NULL,
"url" text NOT NULL,
"events" text[] DEFAULT '{}'::text[] NOT NULL,
"enabled" boolean DEFAULT true NOT NULL,
"secret" text NOT NULL,
"last_status" text,
"last_error" text,
"last_delivered_at" timestamptz,
"created_at" timestamptz DEFAULT now() NOT NULL,
"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
"id" text PRIMARY KEY NOT NULL,
"webhook_id" text NOT NULL,
"event" text NOT NULL,
"ticket_id" text,
"payload" text NOT NULL,
"status" text DEFAULT 'queued' NOT NULL,
"error" text,
"attempts" integer DEFAULT 0 NOT NULL,
"next_try_at" timestamptz,
"sent_at" timestamptz,
"created_at" timestamptz DEFAULT now() NOT NULL,
CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade,
CONSTRAINT "webhook_deliveries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE "alert_signatures" (
"id" text PRIMARY KEY NOT NULL,
"source" text NOT NULL,
"signature" text NOT NULL,
"ticket_id" text NOT NULL,
"state" text DEFAULT 'open' NOT NULL,
"first_seen_at" timestamptz DEFAULT now() NOT NULL,
"last_seen_at" timestamptz DEFAULT now() NOT NULL,
"created_at" timestamptz DEFAULT now() NOT NULL,
"updated_at" timestamptz DEFAULT now() NOT NULL,
CONSTRAINT "alert_signatures_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade,
CONSTRAINT "alert_signatures_source_signature_unique" UNIQUE ("source", "signature")
);
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries" USING btree ("webhook_id");
