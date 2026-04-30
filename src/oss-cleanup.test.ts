import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// OSS 公開前のコメント整理タスクの完了条件を自動検証する。
// grep ベースの完了条件をテストとして固定化し、再混入を CI で検出可能にする。
//
// パターン文字列はテスト本体が走査対象から除外する（自己マッチ回避）ため、
// この test ファイルにリテラルとして書かれていても完了条件には影響しない。

const SELF = fileURLToPath(import.meta.url);
const SRC_ROOT = resolve(SELF, "..");
const PROJECT_ROOT = resolve(SRC_ROOT, "..");
const DEBATE_COORDINATOR = join(
  SRC_ROOT,
  "application/coordinators/DebateCoordinator.ts"
);

// CLI として stdout に出力する必要があるエントリポイント。
// 「ユーザーが見る文言は変更禁止」のため console.log 検査の対象外とする。
const CONSOLE_LOG_EXEMPT_FILES = new Set<string>([
  resolve(SRC_ROOT, "setup.ts"),
  resolve(SRC_ROOT, "setup-channels.ts"),
  resolve(SRC_ROOT, "index.ts"),
]);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function loadAllTsFiles(): { path: string; content: string }[] {
  return walkTsFiles(SRC_ROOT)
    .filter((path) => path !== SELF)
    .map((path) => ({ path, content: readFileSync(path, "utf8") }));
}

function findMatches(
  files: { path: string; content: string }[],
  pattern: RegExp,
  filter?: (path: string) => boolean
): { path: string; line: number; text: string }[] {
  const hits: { path: string; line: number; text: string }[] = [];
  for (const { path, content } of files) {
    if (filter && !filter(path)) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push({
          path: relative(PROJECT_ROOT, path),
          line: i + 1,
          text: lines[i].trim(),
        });
      }
      // RegExp に g フラグはつけない（毎行新規評価のため lastIndex の影響なし）
    }
  }
  return hits;
}

function formatHits(
  hits: { path: string; line: number; text: string }[]
): string {
  return hits
    .slice(0, 20)
    .map((h) => `  ${h.path}:${h.line}  ${h.text}`)
    .join("\n");
}

test("OSS cleanup: 内部チケット番号 P1-XX / P0-XX が src/ に残っていない", () => {
  const files = loadAllTsFiles();
  // パターンは P (大文字) + 0|1 + ハイフン + 数字
  const pattern = /\bP[01]-\d+/;
  const hits = findMatches(files, pattern);
  assert.equal(
    hits.length,
    0,
    `内部チケット番号 P1-XX / P0-XX への参照が残っている (${hits.length} 件):\n${formatHits(hits)}`
  );
});

test("OSS cleanup: SPEC § 参照が src/ に残っていない", () => {
  const files = loadAllTsFiles();
  const pattern = /SPEC\s*§/;
  const hits = findMatches(files, pattern);
  assert.equal(
    hits.length,
    0,
    `SPEC § 参照が残っている (${hits.length} 件):\n${formatHits(hits)}`
  );
});

test("OSS cleanup: SPEC H[0-9] 参照が src/ に残っていない", () => {
  const files = loadAllTsFiles();
  // "SPEC H1", "SPEC H5" などのコメント参照
  const pattern = /SPEC\s+H\d+/;
  const hits = findMatches(files, pattern);
  assert.equal(
    hits.length,
    0,
    `SPEC H[0-9] 参照が残っている (${hits.length} 件):\n${formatHits(hits)}`
  );
});

test("OSS cleanup: コメント中の単独 H1 / H2 / H3 / H4 / H5 参照が残っていない", () => {
  const files = loadAllTsFiles();
  // コメント行中のチケット記号 "/H3"、"H1:" 形式のみを対象とする。
  // HTML タグ <h1> や JSON フィールドは対象外（このプロジェクトには無いが一般的安全策）。
  const pattern = /(\/\/|\/\*|\*)[^"\n]*\b(?:\/H[1-5]\b|\bH[1-5]\b\s*[:：])/;
  const hits = findMatches(files, pattern);
  assert.equal(
    hits.length,
    0,
    `コメント内の H[1-5] チケット参照が残っている (${hits.length} 件):\n${formatHits(hits)}`
  );
});

test("OSS cleanup: TODO / FIXME / XXX マーカーが src/*.ts に残っていない", () => {
  const files = loadAllTsFiles();
  // 単語境界で TODO / FIXME / XXX を検出する。
  // 通常の英文に紛れる "todo" 等は対象外（プロジェクトの全文は日本語＋英語識別子）。
  const pattern = /\b(?:TODO|FIXME|XXX)\b/;
  const hits = findMatches(files, pattern);
  assert.equal(
    hits.length,
    0,
    `TODO / FIXME / XXX マーカーが残っている (${hits.length} 件):\n${formatHits(hits)}`
  );
});

test("OSS cleanup: 本体側 (CLI 以外) に console.log / console.debug が残っていない", () => {
  const files = loadAllTsFiles();
  const pattern = /\bconsole\.(?:log|debug)\s*\(/;
  const hits = findMatches(
    files,
    pattern,
    (path) => !path.endsWith(".test.ts") && !CONSOLE_LOG_EXEMPT_FILES.has(path)
  );
  assert.equal(
    hits.length,
    0,
    `本体側 console.log / console.debug が残っている (${hits.length} 件):\n` +
      `(CLI エントリポイント ${[...CONSOLE_LOG_EXEMPT_FILES].length} 件は対象外)\n` +
      formatHits(hits)
  );
});

test("OSS cleanup: 絵文字付きコードコメント (// 【...】 / // ★ / // 🔴 等) が残っていない", () => {
  const files = loadAllTsFiles();
  // コードコメントの行頭マーカーのみを検査する（ユーザー向け文字列リテラルは対象外）。
  // 検査対象: // 【 ... / // ★ / // 🔴 / // 🟢 / // 🔵 / // 🟡 / // ⚠ などの装飾接頭辞
  const pattern =
    /^\s*\/\/\s*(?:【|★|🔴|🟢|🔵|🟡|🟣|⚠️|⚠|❗|❌|✅)/u;
  const hits = findMatches(files, pattern);
  assert.equal(
    hits.length,
    0,
    `絵文字・装飾付きコードコメントが残っている (${hits.length} 件):\n${formatHits(hits)}`
  );
});

test("OSS cleanup: AI 風メタコメント (「以下を実装」「次に〜する」) が残っていない", () => {
  const files = loadAllTsFiles();
  // 行頭が // で始まる コメント行のみを対象とする。
  // 「次に進む」のような実装ロジックの説明とは区別するため、典型的な AI 自然文の冒頭表現に絞る。
  const pattern =
    /^\s*\/\/\s*(?:以下(?:を|に)(?:実装|追加|定義|作成)|次に(?:[、。]|\s)|続いて(?:[、。]|\s)|まずは|最後に[、。])/;
  const hits = findMatches(files, pattern);
  assert.equal(
    hits.length,
    0,
    `AI メタコメントが残っている (${hits.length} 件):\n${formatHits(hits)}`
  );
});

test("OSS cleanup: DebateCoordinator.ts は 200 行未満を維持する", () => {
  const stat = statSync(DEBATE_COORDINATOR);
  assert.ok(stat.isFile(), "DebateCoordinator.ts が存在しない");
  const lineCount = readFileSync(DEBATE_COORDINATOR, "utf8").split("\n").length;
  assert.ok(
    lineCount < 200,
    `DebateCoordinator.ts が 200 行を超えている (現在 ${lineCount} 行)`
  );
});

test("OSS cleanup: console.log 検査の対象外ファイル (CLI) が現存する", () => {
  // 対象外リストが古くなって存在しないファイルを参照していないことを保証する。
  for (const path of CONSOLE_LOG_EXEMPT_FILES) {
    assert.ok(
      statSync(path).isFile(),
      `console.log 対象外リストの ${relative(PROJECT_ROOT, path)} が存在しない`
    );
  }
});

test("OSS cleanup: LLM プロンプト本文 (テンプレートリテラル) が変更禁止対象として識別できる", () => {
  // プロンプト本文を含むファイルが期待通りに存在し、cleanup の対象外として扱える状態かを確認する。
  const promptFiles = [
    join(SRC_ROOT, "infrastructure/agents/prompts/a-agent.ts"),
    join(SRC_ROOT, "infrastructure/agents/prompts/b-agent.ts"),
    join(SRC_ROOT, "infrastructure/agents/prompts/judge-agent.ts"),
  ];
  for (const path of promptFiles) {
    const content = readFileSync(path, "utf8");
    // テンプレートリテラル (バッククォート) が含まれていることを確認。
    assert.ok(
      content.includes("`"),
      `${relative(PROJECT_ROOT, path)} にテンプレートリテラルが見つからない`
    );
  }
});
