import { and, inArray, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { moderationScans } from '../db/schema.js';
import { DETECTOR_VERSION, LEXICON_VERSION, safeScanContentRisk, type RiskHint } from './content-risk.js';

export type ModerationTargetType = 'topic' | 'channel' | 'message';

export function moderationScanValues(targetType: ModerationTargetType, targetId: string, text: string) {
  const scan = safeScanContentRisk(text);
  return {
    targetType,
    targetId,
    status: scan.status,
    detectorVersion: DETECTOR_VERSION,
    lexiconVersion: LEXICON_VERSION,
    signals: scan.signals,
    scannedAt: new Date(),
  };
}

export async function getModerationHints(db: Database, targetType: ModerationTargetType, targets: Array<{ id: string; text: string }>) {
  if (!targets.length) return new Map<string, RiskHint[]>();
  const targetIds = targets.map(target => target.id);
  const existingIds = await db.select({ targetId: moderationScans.targetId }).from(moderationScans)
    .where(and(eq(moderationScans.targetType, targetType), inArray(moderationScans.targetId, targetIds)));
  const existing = new Set(existingIds.map(row => row.targetId));
  const missing = targets.filter(target => !existing.has(target.id));
  if (missing.length) {
    await db.insert(moderationScans).values(missing.map(target => moderationScanValues(targetType, target.id, target.text))).onConflictDoNothing();
  }
  const rows = await db.select({ targetId: moderationScans.targetId, status: moderationScans.status, signals: moderationScans.signals })
    .from(moderationScans)
    .where(and(eq(moderationScans.targetType, targetType), inArray(moderationScans.targetId, targetIds)));
  return new Map(rows.map(row => [row.targetId, row.status === 'completed' ? row.signals as RiskHint[] : []]));
}
