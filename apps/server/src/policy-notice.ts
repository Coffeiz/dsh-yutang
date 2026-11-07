import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const policyText = readFileSync(new URL("./prompt/community-policy.md", import.meta.url), "utf8").trim();

if (!policyText) throw new Error("Community policy prompt is empty");

export const communityPolicyNotice = {
  version: `sha256:${createHash("sha256").update(policyText).digest("hex").slice(0, 16)}`,
  text: policyText,
};
