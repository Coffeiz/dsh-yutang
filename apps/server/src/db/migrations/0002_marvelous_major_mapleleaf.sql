CREATE INDEX "channels_created_idx" ON "channels" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "topics_created_idx" ON "topics" USING btree ("created_at");