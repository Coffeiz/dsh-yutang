import { createHash, createPublicKey, verify } from "node:crypto";

export type Ed25519PublicKey = { publicKey: string; fingerprint: string };

export function parseEd25519PublicKey(pem: string): Ed25519PublicKey {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Public key must use Ed25519");
  const der = key.export({ type: "spki", format: "der" });
  return {
    publicKey: der.toString("base64url"),
    fingerprint: createHash("sha256").update(der).digest("hex"),
  };
}

export function verifyEd25519Signature(publicKey: string, message: string, signature: string): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const signatureBytes = Buffer.from(signature, "base64url");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64url") !== signature) return false;
  const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), type: "spki", format: "der" });
  return verify(null, Buffer.from(message, "utf8"), key, signatureBytes);
}
