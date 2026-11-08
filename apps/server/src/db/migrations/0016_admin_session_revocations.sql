CREATE TABLE "admin_session_revocations" (
	"nonce" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_session_revocations_nonce_check" CHECK ("nonce" ~ '^[A-Za-z0-9_-]{32}$')
);
--> statement-breakpoint
CREATE INDEX "admin_session_revocations_expiry_idx" ON "admin_session_revocations" USING btree ("expires_at");
