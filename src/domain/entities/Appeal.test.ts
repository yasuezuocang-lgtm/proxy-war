import test from "node:test";
import assert from "node:assert/strict";
import {
  createAppeal,
  nextCourtLevel,
  type Appeal,
} from "./Appeal.js";
import { DomainError } from "../errors/DomainError.js";

test("createAppeal は district 判定から高裁上告の Appeal を返す", () => {
  const appeal = createAppeal({
    side: "B",
    content: "A側の主張には事実誤認がある",
    currentCourtLevel: "district",
    winner: "A",
    now: 1_700_000_000_000,
  });

  assert.equal(appeal.appellantSide, "B");
  assert.equal(appeal.appealedBy, "B");
  assert.equal(appeal.courtLevel, "high");
  assert.equal(appeal.content, "A側の主張には事実誤認がある");
  assert.equal(appeal.createdAt, 1_700_000_000_000);
  assert.equal(appeal.appealedAt, 1_700_000_000_000);
});

test("createAppeal は high 判定から最高裁への上告を作れる", () => {
  const appeal = createAppeal({
    side: "A",
    content: "高裁判断にも偏りがある",
    currentCourtLevel: "high",
    winner: "B",
  });

  assert.equal(appeal.courtLevel, "supreme");
  assert.equal(appeal.appellantSide, "A");
});

test("createAppeal は引き分け判定では DomainError を投げる（SPEC §6.8）", () => {
  assert.throws(
    () =>
      createAppeal({
        side: "A",
        content: "引き分けには納得できない",
        currentCourtLevel: "district",
        winner: "draw",
      }),
    (err) => err instanceof DomainError && /引き分け/.test(err.message)
  );
});

test("createAppeal は最高裁の判決からは上告を作れない（SPEC §6.8）", () => {
  assert.throws(
    () =>
      createAppeal({
        side: "B",
        content: "最終審にも納得できない",
        currentCourtLevel: "supreme",
        winner: "A",
      }),
    (err) => err instanceof DomainError && /最高裁/.test(err.message)
  );
});

test("createAppeal は勝者側からの上告を拒否する", () => {
  assert.throws(
    () =>
      createAppeal({
        side: "A",
        content: "もっと勝ちたい",
        currentCourtLevel: "district",
        winner: "A",
      }),
    (err) => err instanceof DomainError && /勝者/.test(err.message)
  );
});

test("createAppeal は空の content を拒否する", () => {
  assert.throws(
    () =>
      createAppeal({
        side: "B",
        content: "   \n  ",
        currentCourtLevel: "district",
        winner: "A",
      }),
    (err) => err instanceof DomainError && /異議内容/.test(err.message)
  );
});

test("createAppeal は content をトリムする", () => {
  const appeal = createAppeal({
    side: "B",
    content: "  改行や空白が混じった異議本文  \n",
    currentCourtLevel: "district",
    winner: "A",
  });
  assert.equal(appeal.content, "改行や空白が混じった異議本文");
});

test("nextCourtLevel: district→high, high→supreme, supreme→null", () => {
  assert.equal(nextCourtLevel("district"), "high");
  assert.equal(nextCourtLevel("high"), "supreme");
  assert.equal(nextCourtLevel("supreme"), null);
});

test("Appeal 型は既存の直接構築（appellantSide/content/createdAt のみ）も許容する", () => {
  const legacy: Appeal = {
    appellantSide: "A",
    content: "レガシー形式",
    createdAt: 1,
  };
  assert.equal(legacy.appealedBy, undefined);
  assert.equal(legacy.courtLevel, undefined);
  assert.equal(legacy.appealedAt, undefined);
});
