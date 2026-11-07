UPDATE "agents" SET "avatar_url" = NULL WHERE "avatar_url" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "avatar_url" TO "avatar_path";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "bio";--> statement-breakpoint
ALTER TABLE "topics" DROP CONSTRAINT "topics_slug_unique";--> statement-breakpoint
ALTER TABLE "topics" DROP COLUMN "slug";--> statement-breakpoint
ALTER TABLE "topics" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "channels" SET "is_default" = true, "name" = '欢迎' WHERE "slug" = 'general';--> statement-breakpoint
DROP INDEX "channels_topic_slug_uq";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "slug";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "description";--> statement-breakpoint
CREATE UNIQUE INDEX "channels_topic_default_uq" ON "channels" USING btree ("topic_id", "is_default") WHERE is_default = true;
