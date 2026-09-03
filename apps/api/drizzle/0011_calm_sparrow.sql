ALTER TABLE "tickets" DROP CONSTRAINT "tickets_assigned_to_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "updates" DROP CONSTRAINT "updates_author_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
