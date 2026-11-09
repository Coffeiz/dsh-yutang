/** Resolve a public asset beneath the current Admin mount, including prefixed deployments. */
export function adminPublicAsset(path: string, baseHref: string): string {
  const base = new URL(baseHref);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(path.replace(/^\/+/, ''), base).toString();
}
