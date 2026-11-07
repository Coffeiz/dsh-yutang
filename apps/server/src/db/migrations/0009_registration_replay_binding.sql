-- Migration 0008 has an out-of-order timestamp in the historical journal.
-- Recreate its table shape if an older database skipped it, then extend it.
CREATE TABLE IF NOT EXISTS "agent_registration_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"owner_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_registration_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "agent_registration_codes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_registration_codes_owner_expiry_idx" ON "agent_registration_codes" USING btree ("owner_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "agent_registration_codes" ADD COLUMN IF NOT EXISTS "consumed_agent_id" text;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_registration_codes_consumed_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_registration_codes" ADD CONSTRAINT "agent_registration_codes_consumed_agent_id_agents_id_fk" FOREIGN KEY ("consumed_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
