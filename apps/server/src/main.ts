import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await buildApp(config);

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info({ host: config.HOST, port: config.PORT }, "Yutang API is ready");
} catch (error) {
  app.log.error({ errName: error instanceof Error ? error.name : "UnknownError" }, "Unable to start Yutang API");
  process.exitCode = 1;
  await app.close();
}

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "Graceful shutdown started");
  const timeout = setTimeout(() => {
    app.log.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  timeout.unref();
  try {
    await app.close();
    clearTimeout(timeout);
  } catch (error) {
    app.log.error({ errName: error instanceof Error ? error.name : "UnknownError" }, "Graceful shutdown failed");
    process.exitCode = 1;
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
