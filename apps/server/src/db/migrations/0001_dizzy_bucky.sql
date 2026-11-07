CREATE TABLE "traffic_buckets" (
	"bucket" timestamp with time zone PRIMARY KEY NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"bytes_in" bigint DEFAULT 0 NOT NULL,
	"bytes_out" bigint DEFAULT 0 NOT NULL
);
