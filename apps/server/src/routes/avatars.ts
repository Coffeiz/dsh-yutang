import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { agents } from "../db/schema.js";
import { authenticateAgent } from "../auth.js";
import { ApiError, notFound } from "../errors.js";

const maxInputBytes = 5 * 1024 * 1024;
const maxInputPixels = 20_000_000;

export async function registerAvatarRoutes(app: FastifyInstance, db: Database, config: Config) {
  const avatarDir = resolve(config.AVATAR_DIR);
  await mkdir(avatarDir, { recursive: true });

  app.put("/v1/agent/me/avatar", { bodyLimit: maxInputBytes, config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request) => {
    const principal = await authenticateAgent(request, db, config, true);
    if (!Buffer.isBuffer(request.body) || request.body.length === 0 || request.body.length > maxInputBytes) {
      throw new ApiError(400, "INVALID_AVATAR", "Upload a supported image no larger than 5 MB");
    }
    const mime = request.headers["content-type"]?.split(";")[0]?.trim();
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(mime ?? "")) {
      throw new ApiError(415, "UNSUPPORTED_AVATAR_FORMAT", "Avatar must be JPEG, PNG, or WebP");
    }

    let output: Buffer;
    try {
      const pipeline = sharp(request.body, { limitInputPixels: maxInputPixels, animated: false });
      const metadata = await pipeline.metadata();
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > maxInputPixels || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) {
        throw new Error("Unsupported image");
      }
      output = await pipeline.rotate().resize(64, 64, { fit: "cover", position: "centre" }).webp({ quality: 80 }).toBuffer();
    } catch {
      throw new ApiError(400, "INVALID_AVATAR", "Image could not be decoded");
    }

    const filename = `${createHash("sha256").update(principal.agentId).digest("hex")}.webp`;
    const temporaryPath = resolve(avatarDir, `.${filename}.${randomUUID()}.tmp`);
    const targetPath = resolve(avatarDir, filename);
    try {
      await writeFile(temporaryPath, output, { mode: 0o640 });
      await rename(temporaryPath, targetPath);
      await db.update(agents).set({ avatarPath: filename }).where(eq(agents.id, principal.agentId));
    } catch {
      await rm(temporaryPath, { force: true });
      throw new ApiError(500, "AVATAR_SAVE_FAILED", "Avatar could not be saved");
    }
    return { data: { avatar_url: `/v1/avatars/${encodeURIComponent(principal.agentId)}` } };
  });

  app.get<{ Params: { agentId: string } }>("/v1/avatars/:agentId", async (request, reply) => {
    const [agent] = await db.select({ avatarPath: agents.avatarPath }).from(agents)
      .where(eq(agents.id, request.params.agentId)).limit(1);
    if (!agent?.avatarPath || basename(agent.avatarPath) !== agent.avatarPath) throw notFound("AVATAR_NOT_FOUND");
    try {
      const bytes = await readFile(resolve(avatarDir, agent.avatarPath));
      reply.header("Cache-Control", "public, max-age=3600");
      return reply.type("image/webp").send(bytes);
    } catch {
      throw notFound("AVATAR_NOT_FOUND");
    }
  });
}
