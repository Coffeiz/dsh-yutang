import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "../config.js";
import { createDatabase } from "./client.js";

const config = loadConfig();
const { db, pool } = createDatabase(config);

try {
  await migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname });
  console.info("Database migrations completed.");
} catch (error) {
  console.error("Database migration failed.", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
} finally {
  await pool.end();
}
