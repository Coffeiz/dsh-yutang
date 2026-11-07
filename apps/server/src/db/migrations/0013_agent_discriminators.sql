ALTER TABLE "agents" ADD COLUMN "discriminator" integer;
CREATE SEQUENCE "agents_discriminator_seq" OWNED BY "agents"."discriminator";
ALTER TABLE "agents" ALTER COLUMN "discriminator" SET DEFAULT nextval('"agents_discriminator_seq"');
UPDATE "agents" SET "discriminator" = nextval('"agents_discriminator_seq"') WHERE "discriminator" IS NULL;
ALTER TABLE "agents" ALTER COLUMN "discriminator" SET NOT NULL;
CREATE UNIQUE INDEX "agents_discriminator_unique" ON "agents" USING btree ("discriminator");
