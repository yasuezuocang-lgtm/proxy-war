// 構造化ブリーフから「追加質問が必要なほど不足しているか」を判定する。
// 純粋関数。LLM や外部依存を持たない。
const GAP_PATTERNS = [
  /■インタレスト[^■]*不明/s,
  /■武器[^■]*不明/s,
  /■弱点[^■]*不明/s,
  /■NGワード[^■]*未確認/s,
];

const SIGNIFICANT_GAP_THRESHOLD = 2;

export function hasSignificantGaps(structuredContext: string): boolean {
  let gapCount = 0;
  for (const pattern of GAP_PATTERNS) {
    if (pattern.test(structuredContext)) {
      gapCount++;
    }
  }
  return gapCount >= SIGNIFICANT_GAP_THRESHOLD;
}
