import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHelpMessage,
  isHelpCommand,
  type HelpContext,
} from "./HelpRegistry.js";

test("isHelpCommand は help / ヘルプ / 大文字・空白を許容", () => {
  assert.equal(isHelpCommand("help"), true);
  assert.equal(isHelpCommand("HELP"), true);
  assert.equal(isHelpCommand(" help "), true);
  assert.equal(isHelpCommand("ヘルプ"), true);
  assert.equal(isHelpCommand(" ヘルプ "), true);
});

test("isHelpCommand は help に無関係な文字列を false にする", () => {
  assert.equal(isHelpCommand("リセット"), false);
  assert.equal(isHelpCommand("helper"), false);
  assert.equal(isHelpCommand("help me"), false);
  assert.equal(isHelpCommand(""), false);
});

test("セッション無しでは本音入力とリセットを案内する", () => {
  const msg = buildHelpMessage({
    sessionPhase: null,
    participantPhase: null,
    canAppeal: false,
  });
  assert.ok(msg.startsWith("今できる操作:"));
  assert.match(msg, /本音をそのまま送る/);
  assert.match(msg, /リセット/);
  // preparing 中に「ゴール」「上告」等を案内しない
  assert.doesNotMatch(msg, /ゴール/);
  assert.doesNotMatch(msg, /上告/);
});

test("preparing / confirming では「はい」と修正案内を出す", () => {
  const msg = buildHelpMessage({
    sessionPhase: "preparing",
    participantPhase: "confirming",
    canAppeal: false,
  });
  assert.match(msg, /「はい」で要約を確定/);
  assert.match(msg, /修正したい点を送る/);
  assert.match(msg, /リセット/);
});

test("preparing / goal_setting ではゴール設定・スキップを案内する", () => {
  const msg = buildHelpMessage({
    sessionPhase: "preparing",
    participantPhase: "goal_setting",
    canAppeal: false,
  });
  assert.match(msg, /ゴール:/);
  assert.match(msg, /なし/);
  assert.match(msg, /スキップ/);
});

test("preparing / ready（片側だけ）では相手待ちを案内する", () => {
  const msg = buildHelpMessage({
    sessionPhase: "preparing",
    participantPhase: "ready",
    canAppeal: false,
  });
  assert.match(msg, /相手の準備待ち/);
});

test("hearing フェーズではDM回答を案内する", () => {
  const msg = buildHelpMessage({
    sessionPhase: "hearing",
    participantPhase: "ready",
    canAppeal: false,
  });
  assert.match(msg, /ヒアリング質問にDMで答える/);
});

test("appeal_pending で canAppeal=true なら「上告」を案内", () => {
  const msg = buildHelpMessage({
    sessionPhase: "appeal_pending",
    participantPhase: "ready",
    canAppeal: true,
  });
  assert.match(msg, /「上告」/);
  assert.doesNotMatch(msg, /相手の上告判断待ち/);
});

test("appeal_pending で canAppeal=false なら「上告」を出さず待機案内", () => {
  const msg = buildHelpMessage({
    sessionPhase: "appeal_pending",
    participantPhase: "ready",
    canAppeal: false,
  });
  assert.doesNotMatch(msg, /「上告」/);
  assert.match(msg, /相手の上告判断待ち/);
});

test("finished フェーズでは新セッション案内を出す", () => {
  const msg = buildHelpMessage({
    sessionPhase: "finished",
    participantPhase: "ready",
    canAppeal: false,
  });
  assert.match(msg, /新しい本音を送って次のセッション/);
});

test("debating では #talk を見守る旨を案内", () => {
  const ctx: HelpContext = {
    sessionPhase: "debating",
    participantPhase: "ready",
    canAppeal: false,
  };
  const msg = buildHelpMessage(ctx);
  assert.match(msg, /#talk/);
  assert.match(msg, /喧嘩中/);
});
