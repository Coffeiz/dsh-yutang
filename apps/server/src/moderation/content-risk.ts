import AhoCorasick from 'modern-ahocorasick';

export const DETECTOR_VERSION = 'yutang-risk-1';
export const LEXICON_VERSION = 'starter-en-zh-1';

export type RiskCategory = 'profanity' | 'harassment' | 'sexual_explicit' | 'political_reference' | 'incitement' | 'advertising';
export type RiskLanguage = 'zh' | 'en' | 'mixed';
export type RiskHint = { category: RiskCategory; language: RiskLanguage };
type LexiconEntry = { category: RiskCategory; language: 'zh' | 'en' };

// This is a small, explicitly versioned starter list. It is a triage signal,
// not an exhaustive or context-aware content policy.
const entries: Array<{ pattern: string; data: LexiconEntry }> = [
  ...(([
    ['profanity', ['操你', '他妈的', '傻逼', '混蛋', '王八蛋']],
    ['harassment', ['去死', '废物', '滚开', '人渣', '杀了你']],
    ['sexual_explicit', ['色情', '裸聊', '性交易', '成人视频', '成人电影']],
    ['political_reference', ['政治', '政党', '选举', '总统', '国会', '政府', '反动', '独裁', '革命']],
    ['incitement', ['煽动暴力', '暴力推翻', '袭击政府', '煽动仇恨']],
  ] as Array<[RiskCategory, string[]]>).flatMap(([category, patterns]) => patterns.map(pattern => ({ pattern, data: { category, language: 'zh' as const } })))),
  ...(([
    ['profanity', ['fuck', 'shit', 'bitch', 'asshole', 'bastard']],
    ['harassment', ['go die', 'kill yourself', 'you are worthless', 'piece of shit']],
    ['sexual_explicit', ['pornography', 'porn', 'nudes', 'explicit sex', 'sex trade']],
    ['political_reference', ['politics', 'political', 'election', 'president', 'parliament', 'government', 'political party', 'dictatorship', 'revolution']],
    ['incitement', ['violent overthrow', 'incite violence', 'attack the government', 'incite hatred']],
  ] as Array<[RiskCategory, string[]]>).flatMap(([category, patterns]) => patterns.map(pattern => ({ pattern, data: { category, language: 'en' as const } })))),
];

const matcher = new AhoCorasick<LexiconEntry>(entries);
const categoryOrder: RiskCategory[] = ['profanity', 'harassment', 'sexual_explicit', 'political_reference', 'incitement', 'advertising'];
const urlPattern = /(?:https?:\/\/|www\.)[^\s<>]+/giu;
const marketingCue = /(?:加(?:我|群|微)|扫码|私信(?:我)?|限时(?:优惠|折扣)?|立即购买|优惠券|返利|代理(?:加盟)?|buy\s+now|limited\s+offer|discount\s+code|dm\s+me|join\s+my\s+(?:group|channel)|promo\s+code)/iu;

function isEnglishWordBoundary(text: string, start: number, end: number) {
  const before = start > 0 ? text[start - 1] ?? '' : '';
  const after = end < text.length ? text[end] ?? '' : '';
  return !/[A-Za-z0-9_]/u.test(before) && !/[A-Za-z0-9_]/u.test(after);
}

export function scanContentRisk(text: string): RiskHint[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US');
  const languagesByCategory = new Map<RiskCategory, Set<RiskLanguage>>();
  for (const hit of matcher.search(normalized)) {
    if (!hit.data) continue;
    if (hit.data.language === 'en' && !isEnglishWordBoundary(normalized, hit.start, hit.end)) continue;
    const languages = languagesByCategory.get(hit.data.category) ?? new Set<RiskLanguage>();
    languages.add(hit.data.language);
    languagesByCategory.set(hit.data.category, languages);
  }
  const urls = normalized.match(urlPattern) ?? [];
  if (urls.length >= 2 || urls.length >= 1 && marketingCue.test(normalized)) languagesByCategory.set('advertising', new Set(['mixed']));
  return categoryOrder.flatMap(category => {
    const languages = languagesByCategory.get(category);
    if (!languages) return [];
    const language = languages.has('mixed') || languages.size > 1 ? 'mixed' : [...languages][0]!;
    return [{ category, language }];
  });
}

export function safeScanContentRisk(text: string): { status: 'completed' | 'unavailable'; signals: RiskHint[] } {
  try { return { status: 'completed', signals: scanContentRisk(text) }; }
  catch { return { status: 'unavailable', signals: [] }; }
}
