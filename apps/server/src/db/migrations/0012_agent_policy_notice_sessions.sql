CREATE TABLE "agent_policy_notice_sessions" (
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"policy_present" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_policy_notice_sessions_pkey" PRIMARY KEY("agent_id", "session_id"),
	CONSTRAINT "agent_policy_notice_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action
);
