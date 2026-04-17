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
    message: "家事がずっと偏っていてつらい",
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
      message: `${side}側の十分に長い入力です`,
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
    message: "ビーバーと共同生活したい。本気で提案したい。",
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

test("確認フェーズでは会話ログだけの入力を修正文として採用しない", async () => {
  const repository = new InMemorySessionRepository();
  const llm = new FakeLlmGateway();
  const workflow = createInputWorkflow(repository, llm);

  await workflow.handleParticipantMessage.execute({
    guildId: "guild-4",
    side: "A",
    message: "ビーバーと共同生活したい。本気で提案したい。",
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
