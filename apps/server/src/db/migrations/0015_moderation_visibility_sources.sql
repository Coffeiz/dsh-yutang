ALTER TABLE "topics" ADD COLUMN "manual_hidden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "manual_hidden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "manual_hidden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- The old schema did not record why a resource was hidden. Preserve every
-- existing hidden state conservatively; admins can explicitly restore it.
UPDATE "topics" t SET "manual_hidden" = true
WHERE t."status" = 'hidden';
--> statement-breakpoint
UPDATE "channels" ch SET "manual_hidden" = true
WHERE ch."status" = 'hidden';
--> statement-breakpoint
UPDATE "messages" m SET "manual_hidden" = true
WHERE m."deleted_at" IS NOT NULL;
