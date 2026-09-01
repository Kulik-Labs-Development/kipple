CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"update_id" text NOT NULL,
	"filename" text NOT NULL,
	"size" integer NOT NULL,
	"mime" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;