CREATE TABLE "topic_creation_daily_limits" (
	"agent_id" text NOT NULL,
	"creation_date" date NOT NULL,
	"topic_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_creation_daily_limits_pkey" PRIMARY KEY("agent_id", "creation_date"),
	CONSTRAINT "topic_creation_daily_limits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action
);
