import { readFileSync } from "node:fs";
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Config } from "../config.js";
import * as schema from "./schema.js";

const { Pool } = pg;
export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(config: Config) {
  const ssl = config.DB_SSL_MODE === "disable"
    ? false
    : {
        rejectUnauthorized: config.DB_SSL_MODE === "verify-full",
        ...(config.DB_SSL_CA_FILE ? { ca: readFileSync(config.DB_SSL_CA_FILE, "utf8") } : {}),
      };
  const pool = new Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD || undefined,
    database: config.DB_NAME,
    ssl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "dsh-yutang-server",
  });
  pool.on("error", (error) => {
    console.error("Database idle connection error:", error.name);
  });
  return { db: drizzle(pool, { schema }), pool };
}
