import { ulid } from "ulid";

export function createId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export function agentTag(discriminator: number): string {
  return discriminator.toString(36).toUpperCase().padStart(4, "0");
}

export function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}
