CREATE TABLE "api_keys" (
"id" text PRIMARY KEY NOT NULL,
"name" text NOT NULL,
"key_hash" text NOT NULL,
"key_prefix" text NOT NULL,
"scopes" text[] DEFAULT '{}' NOT NULL,
"user_id" text NOT NULL,
"created_at" timestamptz DEFAULT now() NOT NULL,
"expires_at" timestamptz,
"last_used_at" timestamptz,
"revoked_at" timestamptz,
CONSTRAINT "api_keys_key_hash_unique" UNIQUE ("key_hash"),
CONSTRAINT "api_keys_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_user_name" ON "api_keys" ("user_id", "name");
