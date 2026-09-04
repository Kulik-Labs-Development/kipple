ALTER TABLE "users" ADD COLUMN "mfa_required" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE "staff_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL DEFAULT 'agent',
	"token_hash" text NOT NULL,
	"invited_by" text REFERENCES "public"."users"("id") ON DELETE set null,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"revoked_at" timestamptz,
	"accepted_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invites_token_hash_unique" ON "staff_invites" ("token_hash");
