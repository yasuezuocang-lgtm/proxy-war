import test from "node:test";
import assert from "node:assert/strict";
import { createInputWorkflow } from "../factories/createInputWorkflow.js";
import { InMemorySessionRepository } from "../../infrastructure/persistence/InMemorySessionRepository.js";
import type {
  AppendBriefInput,
  BriefInput,
  ConsolationInput,
  JudgeRoundInput,
  LlmGateway,
  StructuredBrief,
} from "../ports/LlmGateway.js";
import type { Judgment } from "../../domain/entities/Judgment.js";

class FakeLlmGateway implements LlmGateway {
  readonly appendInputs: string[] = [];

  async extractBrief(input: BriefInput): Promise<StructuredBrief> {
    const rawText = input.rawInputs.join("\n");
    return {
      structuredContext:
        "■案件の理解:\n" +
        `${rawText}\n` +
        "■インタレスト:\n対等でいたい\n" +
        "■武器:\n家事の偏り\n" +
        "■弱点:\n不明\n" +
        "■NGワード:\nなし",
      summary: `要約:${rawText}`,
    };
  }

  async appendBrief(input: AppendBriefInput): Promise<StructuredBrief> {
    this.appendInputs.push(input.additionalInput);
    return {
      structuredContext: `${input.currentStructuredContext}\n追記:${input.additionalInput}`,
      summary: `更新要約:${input.additionalInput}`,
    };
  }

  async generateProbe(): Promise<string> {
    return "追加で具体例を教えて。";
  }

  async judgeRound(_input: JudgeRoundInput): Promise<Judgment> {
    return {
      winner: "draw",
      criteria: [],
      totalA: 0,
      totalB: 0,
      summary: "引き分け",
      zopa: null,
      wisdom: null,
      angerA: null,
      angerB: null,
    };
  }

  async generateConsolation(_input: ConsolationInput): Promise<string> {
    return "次に活かそう。";
  }
}

test("入力から確認、ゴール設定まで進める", async () => {
  const repository = new InMemorySessionRepository();
  const workflow = createInputWorkflow(repository, new FakeLlmGateway());

  const first = await workflow.handleParticipantMessage.execute({
    guildId: "guild-1",
    side: "A",
    message:
      "家事がずっと偏っていてつらい。毎週末も平日もずっと私ばかりがやっていて、もう限界を感じている。きちんと話し合って対等に分担したい。",
  });

  assert.equal(first.handledBy, "submit_input");
  assert.equal(first.movedToConfirming, true);
  assert.match(first.reply, /これで戦う/);

  const confirm = await workflow.handleParticipantMessage.execute({
    guildId: "guild-1",
    side: "A",
    message: "はい",
  });

  assert.equal(confirm.handledBy, "confirm_brief");
  assert.equal(confirm.movedToGoalSetting, true);
  assert.match(confirm.reply, /ゴール/);

  const goal = await workflow.handleParticipantMessage.execute({
    guildId: "guild-1",
    side: "A",
    message: "ゴール:謝ってほしい",
  });

  assert.equal(goal.handledBy, "set_goal");
  assert.equal(goal.participantReady, true);
  assert.equal(goal.sessionReady, false);
  assert.equal(goal.session.getParticipant("A").brief.goal, "謝ってほしい");
});

test("両者の準備完了でセッションが ready になる", async () => {
  const repository = new InMemorySessionRepository();
  const workflow = createInputWorkflow(repository, new FakeLlmGateway());

  for (const side of ["A", "B"] as const) {
    await workflow.handleParticipantMessage.execute({
      guildId: "guild-2",
      side,
      message: `${side}側の本音です。相手との関係で不満が積もっていて、具体的な事実と気持ちを整理して、ちゃんと話し合いたいと思っています。`,
    });
    await workflow.handleParticipantMessage.execute({
      guildId: "guild-2",
      side,
      message: "はい",
    });
    await workflow.handleParticipantMessage.execute({
      guildId: "guild-2",
      side,
      message: "なし",
    });
  }

  const session = await repository.findActiveByGuildId("guild-2");
  assert.ok(session);
  assert.equal(session.phase, "ready");
});

test("確認フェーズではAI返答の引用を除外して本人の修正だけ反映する", async () => {
  const repository = new InMemorySessionRepository();
  const llm = new FakeLlmGateway();
  const workflow = createInputWorkflow(repository, llm);

  await workflow.handleParticipantMessage.execute({
    guildId: "guild-3",
    side: "A",
    message:
      "ビーバーと共同生活したい。本気で行政に提案したい。生活環境も整える予定で、共に暮らす理由を説明して認めてもらう方法を相談したい。",
  });

  const correction = await workflow.handleParticipantMessage.execute({
    guildId: "guild-3",
    side: "A",
    message:
      "相手は動物園じゃなくて行政。\n" +
      "AI\n" +
      "アプリ\n" +
      "— 21:06\n" +
      "申し訳ありませんが、私は実際の依頼人ではなく、AIアシスタントです。\n" +
      "これで戦う。「はい」で確定、違うとこあれば送って\n" +
      "相手は誰？",
  });

  assert.equal(correction.handledBy, "confirm_brief");
  assert.match(correction.reply, /更新要約:相手は動物園じゃなくて行政。/);
  assert.deepEqual(llm.appendInputs, ["相手は動物園じゃなくて行政。"]);
});

test("help コマンドはセッション未作成でも文脈に合う案内を返す", async () => {
  const repository = new InMemorySessionRepository();
  const workflow = createInputWorkflow(repository, new FakeLlmGateway());

  const noSession = await workflow.handleParticipantMessage.execute({
    guildId: "guild-help-1",
    side: "A",
    message: "help",
  });

  assert.equal(noSession.handledBy, "help");
  assert.equal(noSession.sessionId, null);
  assert.match(noSession.reply, /今できる操作:/);
  assert.match(noSession.reply, /本音をそのまま送る/);

  // セッションが confirming になった後は「はい」案内を返す
  await workflow.handleParticipantMessage.execute({
    guildId: "guild-help-1",
    side: "A",
    message:
      "家事がずっと偏っていてつらい。毎週末も平日もずっと私ばかりがやっていて、もう限界を感じている。きちんと話し合って対等に分担したい。",
  });

  const inConfirming = await workflow.handleParticipantMessage.execute({
    guildId: "guild-help-1",
    side: "A",
    message: "ヘルプ",
  });

  assert.equal(inConfirming.handledBy, "help");
  assert.ok(inConfirming.sessionId);
  assert.match(inConfirming.reply, /「はい」で要約を確定/);
});

test("英語・大文字の yes / goal: / skip コマンドも受け付ける（SPEC §7.4）", async () => {
  const repository = new InMemorySessionRepository();
  const workflow = createInputWorkflow(repository, new FakeLlmGateway());

  const longInput =
    "家事がずっと偏っていてつらい。毎週末も平日もずっと私ばかりがやっていて、もう限界を感じている。きちんと話し合って対等に分担したい。";

  await workflow.handleParticipantMessage.execute({
    guildId: "guild-en-1",
    side: "A",
    message: longInput,
  });

  const confirmUpper = await workflow.handleParticipantMessage.execute({
    guildId: "guild-en-1",
    side: "A",
    message: "YES",
  });
  assert.equal(confirmUpper.handledBy, "confirm_brief");
  if (confirmUpper.handledBy === "confirm_brief") {
    assert.equal(confirmUpper.movedToGoalSetting, true);
  }

  const goalMixed = await workflow.handleParticipantMessage.execute({
    guildId: "guild-en-1",
    side: "A",
    message: "Goal: talk it out",
  });
  assert.equal(goalMixed.handledBy, "set_goal");
  if (goalMixed.handledBy === "set_goal") {
    assert.equal(goalMixed.participantReady, true);
    assert.equal(
      goalMixed.session.getParticipant("A").brief.goal,
      "talk it out"
    );
  }

  await workflow.handleParticipantMessage.execute({
    guildId: "guild-en-2",
    side: "A",
    message: longInput,
  });
  const confirmOk = await workflow.handleParticipantMessage.execute({
    guildId: "guild-en-2",
    side: "A",
    message: "Ok",
  });
  assert.equal(confirmOk.handledBy, "confirm_brief");
  if (confirmOk.handledBy === "confirm_brief") {
    assert.equal(confirmOk.movedToGoalSetting, true);
  }

  const skipUpper = await workflow.handleParticipantMessage.execute({
    guildId: "guild-en-2",
    side: "A",
    message: "SKIP",
  });
  assert.equal(skipUpper.handledBy, "set_goal");
  if (skipUpper.handledBy === "set_goal") {
    assert.equal(skipUpper.participantReady, true);
    assert.equal(skipUpper.session.getParticipant("A").brief.goal, null);
  }
});

test("help コマンドは HELP / Help など大文字でも動く（SPEC §7.4）", async () => {
  const repository = new InMemorySessionRepository();
  const workflow = createInputWorkflow(repository, new FakeLlmGateway());

  for (const command of ["HELP", "Help", " help ", "ヘルプ"]) {
    const result = await workflow.handleParticipantMessage.execute({
      guildId: "guild-en-help",
      side: "A",
      message: command,
    });
    assert.equal(result.handledBy, "help", `command=${command}`);
    assert.match(result.reply, /今できる操作:/, `command=${command}`);
  }
});

test("確認フェーズでは会話ログだけの入力を修正文として採用しない", async () => {
  const repository = new InMemorySessionRepository();
  const llm = new FakeLlmGateway();
  const workflow = createInputWorkflow(repository, llm);

  await workflow.handleParticipantMessage.execute({
    guildId: "guild-4",
    side: "A",
    message:
      "ビーバーと共同生活したい。本気で行政に提案したい。生活環境も整える予定で、共に暮らす理由を説明して認めてもらう方法を相談したい。",
  });

  const correction = await workflow.handleParticipantMessage.execute({
    guildId: "guild-4",
    side: "A",
    message:
      "AI\n" +
      "アプリ\n" +
      "— 21:06\n" +
      "申し訳ありませんが、私は実際の依頼人ではなく、AIアシスタントです。",
  });

  assert.equal(correction.handledBy, "confirm_brief");
  assert.match(correction.reply, /修正したい点だけ送って/);
  assert.deepEqual(llm.appendInputs, []);
});
