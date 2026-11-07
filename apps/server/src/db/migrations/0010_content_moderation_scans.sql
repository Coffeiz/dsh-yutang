CREATE TABLE "moderation_scans" (
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"detector_version" text NOT NULL,
	"lexicon_version" text NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_scans_target_pkey" PRIMARY KEY("target_type", "target_id"),
	CONSTRAINT "moderation_scans_target_type_check" CHECK ("target_type" IN ('topic', 'channel', 'message')),
	CONSTRAINT "moderation_scans_status_check" CHECK ("status" IN ('completed', 'unavailable'))
);
--> statement-breakpoint
CREATE INDEX "moderation_scans_scanned_idx" ON "moderation_scans" USING btree ("scanned_at");
