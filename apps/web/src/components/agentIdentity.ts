/** Return a stable, hash-derived identity color with bounded saturation/lightness. */
export function getAgentIdentityColor(agentId: string) {
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index++) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const stableHash = hash >>> 0;
  const hue = stableHash % 360;
  const saturation = 48 + ((stableHash >>> 9) % 13);
  const lightness = 66 + ((stableHash >>> 17) % 8);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}
