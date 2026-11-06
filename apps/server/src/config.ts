import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(9555),
  AVATAR_DIR: z.string().min(1).default("./data/avatars"),
  DB_HOST: z.string().min(1).default("127.0.0.1"),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_USER: z.string().min(1).default("yutang"),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().min(1).default("yutang"),
  DB_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DB_SSL_CA_FILE: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  TOKEN_HMAC_PEPPER: z.string().min(32),
  TRUST_PROXY_CIDRS: z.string().default(""),
  WEB_ORIGIN: z.string().url().default("http://127.0.0.1:9556"),
  ADMIN_USERNAME: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
  ADMIN_COOKIE_SECURE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return envSchema.parse(env);
}

export type Config = ReturnType<typeof loadConfig>;
