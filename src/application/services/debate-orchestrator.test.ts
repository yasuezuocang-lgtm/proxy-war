import test from "node:test";
import assert from "node:assert/strict";
import { DebateOrchestrator } from "./DebateOrchestrator.js";
import { SessionStateMachine } from "./SessionStateMachine.js";
import { Session } from "../../domain/entities/Session.js";
import { SessionPolicy } from "../../domain/policies/SessionPolicy.js";
import { InMemorySessionRepository } from "../../infrastructure/persistence/InMemorySessionRepository.js";
import type { MessageGateway } from "../ports/MessageGateway.js";
import type {
  AnyResponse,
  ParticipantResponseGateway,
} from "../ports/ParticipantResponseGateway.js";
import type {
  AbsorbHearingAnswerInput,
  AgentTurnInput,
  AgentTurnResult,
  DebateAgent,
  HearingAnswerReview,
  ReviewHearingAnswerInput,
  SuggestAppealInput,
} from "../ports/ParticipantAgent.js";
import type { ParticipantSide } from "../../domain/entities/Participant.js";
import type { AgentPersonality } from "../../domain/entities/AgentContext.js";
import type {
  AppendBriefInput,
  BriefInput,
  ConsolationInput,
  JudgeRoundInput,
  LlmGateway,
  StructuredBrief,
} from "../ports/LlmGateway.js";
import type { Judgment } from "../../domain/entities/Judgment.js";

class FakeDebateLlmGateway implements LlmGateway {
  async extractBrief(_input: BriefInput): Promise<StructuredBrief> {
    return { structuredContext: "", summary: "" };
  }

  async appendBrief(input: AppendBriefInput): Promise<StructuredBrief> {
    return {
      structuredContext: `${input.currentStructuredContext}\n${input.additionalInput}`,
      summary: input.additionalInput,
    };
  }

  async generateProbe(): Promise<string> {
    return "追加質問";
  }

  async judgeRound(_input: JudgeRoundInput): Promise<Judgment> {
    return {
      winner: "A",
      criteria: [
        { name: "説得力", scoreA: 4, scoreB: 3, reason: "Aの方が一貫していた" },
      ],
      totalA: 4,
      totalB: 3,
      summary: "A側がやや優勢。",
      zopa: "週1で話す。",
      wisdom: "怒りの裏の意図を言葉にした方がよい。",
      angerA: null,
      angerB: null,
    };
  }

  async generateConsolation(_input: ConsolationInput): Promise<string> {
    return "次に活かそう。";
  }
}

class FakeMessageGateway implements MessageGateway {
  readonly dms: { side: "A" | "B"; message: string }[] = [];
  readonly talks: { message: string; speaker: "A" | "B" | "system" }[] = [];

  async sendDm(side: "A" | "B", message: string): Promise<void> {
    this.dms.push({ side, message });
  }

  async sendTalkMessage(
    message: string,
    speaker: "A" | "B" | "system" = "system"
  ): Promise<void> {
    this.talks.push({ message, speaker });
  }

  async sendTyping(): Promise<void> {}
}

class FakeParticipantResponseGateway implements ParticipantResponseGateway {
  async waitForResponse(): Promise<string | null> {
    return null;
  }
  async waitForAnyResponse(): Promise<AnyResponse | null> {
    return null;
  }
}

// 指定した side からの「異議あり」コンテンツを順番に返す。
// waitForResponse / waitForAnyResponse どちらも同じキューから消費する。
class ScriptedAppealGateway implements ParticipantResponseGateway {
  constructor(
    private readonly script: ({ side: "A" | "B"; response: string } | null)[]
  ) {}

  async waitForResponse(
    side: "A" | "B"
  ): Promise<string | null> {
    const next = this.script.shift();
    if (!next) return null;
    if (next.side !== side) return null;
    return next.response;
  }

  async waitForAnyResponse(): Promise<AnyResponse | null> {
    const next = this.script.shift();
    if (!next) return null;
    return next;
  }
}

// 新 DebateAgent<Side> をそのまま満たす。generateTurn（Legacy）は持たず、
// opening/reply と absorb(Promise<void>) + getLastBrief でオーケストレータに繋がる。
class FakeParticipantAgent<Side extends ParticipantSide>
  implements DebateAgent<Side>
{
  readonly turns: string[] = [];
  readonly receivedBriefs: string[] = [];
  readonly receivedAppealInputs: SuggestAppealInput<Side>[] = [];

  readonly personality: AgentPersonality;
  private readonly lastBriefs = new Map<string, StructuredBrief>();
  private readonly memos: string[] = [];

  constructor(readonly side: Side) {
    this.personality = {
      id: `fake-${side.toLowerCase()}`,
      label: `${side}代理（テスト）`,
      promptSeed: "",
    };
  }

  async generateOpeningTurn(
    input: AgentTurnInput<Side>
  ): Promise<AgentTurnResult> {
    return this.runTurn(input);
  }

  async generateReplyTurn(
    input: AgentTurnInput<Side>
  ): Promise<AgentTurnResult> {
    return this.runTurn(input);
  }

  async absorbHearingAnswer(
    input: AbsorbHearingAnswerInput<Side>
  ): Promise<void> {
    this.memos.push(input.answer);
    this.lastBriefs.set(input.sessionId, {
      structuredContext: `${input.currentStructuredContext}\n${input.answer}`,
      summary: input.answer,
    });
  }

  // デフォルト実装は追撃なし。追撃テスト用のサブクラスで override する。
  async reviewHearingAnswer(
    _input: ReviewHearingAnswerInput<Side>
  ): Promise<HearingAnswerReview> {
    return { type: "sufficient" };
  }

  getStrategyMemo(): string {
    return this.memos.join("\n");
  }

  resetSession(): void {}

  getLastBrief(sessionId: string): StructuredBrief | null {
    return this.lastBriefs.get(sessionId) ?? null;
  }

  async suggestAppealPoints(input: SuggestAppealInput<Side>): Promise<string> {
    this.receivedAppealInputs.push(input);
    return `- ${this.side}代理からの提案（brief長=${input.brief.length}）`;
  }

  protected runTurn(input: AgentTurnInput<Side>): Promise<AgentTurnResult> {
    this.receivedBriefs.push(input.brief);
    const message = `${this.side}の発言${input.turnIndex + 1}`;
    this.turns.push(message);
    return Promise.resolve({ type: "message" as const, message });
  }
}

test("対話オーケストレータが対話から判定完了まで進める", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "debate-session",
    guildId: "guild-1",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 0 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  session.getParticipant("A").brief.goal = "Aのゴール";
  session.getParticipant("B").brief.goal = "Bのゴール";
  await repository.save(session);

  const messageGateway = new FakeMessageGateway();
  const agentA = new FakeParticipantAgent("A");
  const agentB = new FakeParticipantAgent("B");
  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: agentA,
      B: agentB,
    },
    new FakeDebateLlmGateway(),
    messageGateway,
    new FakeParticipantResponseGateway(),
    0
  );

  await orchestrator.run(session.id);

  const saved = await repository.findById(session.id);
  assert.ok(saved);
  assert.equal(saved.phase, "finished");
  assert.equal(saved.getCurrentRound().turns.length, 2);
  assert.equal(saved.getCurrentRound().judgment?.winner, "A");
  assert.deepEqual(agentA.turns, ["Aの発言1"]);
  assert.deepEqual(agentB.turns, ["Bの発言2"]);
  assert.match(messageGateway.talks.map((t) => t.message).join("\n"), /喧嘩モード 開始/);
  assert.match(messageGateway.talks.map((t) => t.message).join("\n"), /審判AIが判定中/);
  assert.match(messageGateway.talks.map((t) => t.message).join("\n"), /終了。もう1回やるならBotに「リセット」ってDMして。/);

  const speakerOfAMessage = messageGateway.talks.find(
    (t) => t.message === "Aの発言1"
  )?.speaker;
  const speakerOfBMessage = messageGateway.talks.find(
    (t) => t.message === "Bの発言2"
  )?.speaker;
  assert.equal(speakerOfAMessage, "A");
  assert.equal(speakerOfBMessage, "B");
});

test("ヒアリングが入っても同じ側の手番を消費しない", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "hearing-session",
    guildId: "guild-2",
    policy: new SessionPolicy({ maxTurns: 3, maxAppeals: 0 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  class HearingAgent<Side extends ParticipantSide> extends FakeParticipantAgent<Side> {
    override async runTurn(
      input: AgentTurnInput<Side>
    ): Promise<AgentTurnResult> {
      if (this.side === "B" && input.conversation.length === 1) {
        return {
          type: "hearing" as const,
          question: "確認したい",
          reason: "反論材料が武器リストにない",
        };
      }

      return super.runTurn(input);
    }
  }

  class AnsweringGateway implements ParticipantResponseGateway {
    async waitForResponse(): Promise<string | null> {
      return "追加事情";
    }
    async waitForAnyResponse(): Promise<AnyResponse | null> {
      return null;
    }
  }

  const messageGateway = new FakeMessageGateway();
  const agentA = new HearingAgent("A");
  const agentB = new HearingAgent("B");
  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: agentA,
      B: agentB,
    },
    new FakeDebateLlmGateway(),
    messageGateway,
    new AnsweringGateway(),
    0
  );

  await orchestrator.run(session.id);

  const saved = await repository.findById(session.id);
  assert.ok(saved);
  assert.deepEqual(
    saved.getCurrentRound().turns.map((turn) => turn.speakerSide),
    ["A", "B", "A"]
  );
  assert.match(messageGateway.talks.map((t) => t.message).join("\n"), /ヒアリングタイム — B側の依頼人に確認中/);

  // SPEC H5: 依頼人へのヒアリングDMには「質問」と「確認したい理由」が含まれる
  const hearingDm = messageGateway.dms.find(
    (d) => d.side === "B" && /対話中に確認したいことが出た/.test(d.message)
  );
  assert.ok(hearingDm, "B側の依頼人にヒアリングDMが届いている");
  assert.match(hearingDm.message, /確認したい/, "質問本文が含まれる");
  assert.match(
    hearingDm.message,
    /【確認したい理由】/,
    "理由のラベルがDM本文に含まれる"
  );
  assert.match(
    hearingDm.message,
    /反論材料が武器リストにない/,
    "理由本文がDM本文に含まれる"
  );
});

// SPEC H5: reason が空文字列（抽象質問のフォールバック等）なら
// 理由ブロックは丸ごと省略して、今まで通りの DM になる
test("reason が空なら確認したい理由ブロックはDMに現れない", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "hearing-no-reason",
    guildId: "guild-no-reason",
    policy: new SessionPolicy({ maxTurns: 3, maxAppeals: 0 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  class NoReasonHearingAgent<
    Side extends ParticipantSide
  > extends FakeParticipantAgent<Side> {
    override async runTurn(
      input: AgentTurnInput<Side>
    ): Promise<AgentTurnResult> {
      if (this.side === "B" && input.conversation.length === 1) {
        return {
          type: "hearing" as const,
          question: "確認したい",
          reason: "   ",
        };
      }
      return super.runTurn(input);
    }
  }

  class AnsweringGateway implements ParticipantResponseGateway {
    async waitForResponse(): Promise<string | null> {
      return "追加事情";
    }
    async waitForAnyResponse(): Promise<AnyResponse | null> {
      return null;
    }
  }

  const messageGateway = new FakeMessageGateway();
  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new NoReasonHearingAgent("A"),
      B: new NoReasonHearingAgent("B"),
    },
    new FakeDebateLlmGateway(),
    messageGateway,
    new AnsweringGateway(),
    0
  );

  await orchestrator.run(session.id);

  const hearingDm = messageGateway.dms.find(
    (d) => d.side === "B" && /対話中に確認したいことが出た/.test(d.message)
  );
  assert.ok(hearingDm);
  assert.doesNotMatch(
    hearingDm.message,
    /【確認したい理由】/,
    "reason が空白のみなら理由ブロックは出さない"
  );
});

// SPEC §6.6 / P1-11（H2）: 浅い回答は追撃され、具体的な回答が返ったら対話再開する。
// 最初の回答「よくわからない」→ 追撃質問 → 2回目「3月15日」→ 対話再開。
test("浅いヒアリング回答は追撃されて、具体的な回答で対話が再開する（P1-11/H2）", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "followup-session",
    guildId: "guild-followup",
    // maxHearingsPerSide=1 で、B 側の HEARING は1回だけに絞る。
    // handleHearing 内の追撃は maxHearingFollowups の方で別枠管理される。
    policy: new SessionPolicy({
      maxTurns: 3,
      maxAppeals: 0,
      maxHearingsPerSide: 1,
    }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  // B 側のエージェントが第2ターンで HEARING を発火する。
  // 1回目の回答「よくわからない」を浅いと判定して followup を返し、
  // 2回目の回答「3月15日」で sufficient に切り替える。
  class FollowupHearingAgent<
    Side extends ParticipantSide
  > extends FakeParticipantAgent<Side> {
    private reviewCallCount = 0;

    override async runTurn(
      input: AgentTurnInput<Side>
    ): Promise<AgentTurnResult> {
      if (this.side === "B" && input.conversation.length === 1) {
        return {
          type: "hearing" as const,
          question: "Aが言う連絡が来た話、実際いつ？",
          reason: "反論材料が武器リストにない",
        };
      }
      return super.runTurn(input);
    }

    override async reviewHearingAnswer(
      input: ReviewHearingAnswerInput<Side>
    ): Promise<HearingAnswerReview> {
      this.reviewCallCount += 1;
      if (this.reviewCallCount === 1) {
        return {
          type: "followup",
          question: "何月何日に連絡が来た？",
          reason: "日付の事実確認のため",
        };
      }
      return { type: "sufficient" };
    }
  }

  // 回答を順番に返す gateway（浅い→具体的）。
  class ScriptedAnswerGateway implements ParticipantResponseGateway {
    private readonly answers = ["よくわからない", "3月15日に連絡きた"];
    async waitForResponse(): Promise<string | null> {
      return this.answers.shift() ?? null;
    }
    async waitForAnyResponse(): Promise<AnyResponse | null> {
      return null;
    }
  }

  const messageGateway = new FakeMessageGateway();
  const agentB = new FollowupHearingAgent("B");
  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: agentB,
    },
    new FakeDebateLlmGateway(),
    messageGateway,
    new ScriptedAnswerGateway(),
    0,
    2 // maxHearingFollowups
  );

  await orchestrator.run(session.id);

  // B 側に HEARING DM が2通（初回 + 追撃1回）届いているはず。
  const hearingDms = messageGateway.dms.filter(
    (d) => d.side === "B" && /対話中に確認したいことが出た/.test(d.message)
  );
  assert.equal(hearingDms.length, 2, "初回＋追撃1回で合計2通のヒアリングDM");
  assert.match(
    hearingDms[0].message,
    /実際いつ？/,
    "1通目は最初の質問"
  );
  assert.match(
    hearingDms[1].message,
    /何月何日に連絡が来た/,
    "2通目は追撃質問"
  );

  // 追撃アナウンスが #talk に出ている。
  const talks = messageGateway.talks.map((t) => t.message).join("\n");
  assert.match(talks, /追撃質問（1\/2）/, "追撃のカウンタが #talk に出る");
  assert.match(talks, /ヒアリング完了 — 対話再開/, "最後は対話再開に戻る");

  // B 代理の武器リストには両方の回答が積まれている（次ターンの反論材料）。
  assert.match(agentB.getStrategyMemo(), /よくわからない/);
  assert.match(agentB.getStrategyMemo(), /3月15日に連絡きた/);
});

// SPEC §6.6 / P1-11（H2）: 追撃は maxHearingFollowups で打ち切られる。
// 回答が常に浅くても、上限を超える追撃はしない（ユーザー疲弊防止）。
test("追撃は maxHearingFollowups で打ち切られる（P1-11/H2）", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "followup-cap",
    guildId: "guild-cap",
    // 同じく maxHearingsPerSide=1 で B 側の HEARING を1回に絞る。
    policy: new SessionPolicy({
      maxTurns: 3,
      maxAppeals: 0,
      maxHearingsPerSide: 1,
    }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  // 常に followup を返し続けるエージェント。上限判定は orchestrator 側の責務。
  class AlwaysFollowupAgent<
    Side extends ParticipantSide
  > extends FakeParticipantAgent<Side> {
    override async runTurn(
      input: AgentTurnInput<Side>
    ): Promise<AgentTurnResult> {
      if (this.side === "B" && input.conversation.length === 1) {
        return {
          type: "hearing" as const,
          question: "最初の質問",
          reason: "反論材料が足りない",
        };
      }
      return super.runTurn(input);
    }

    override async reviewHearingAnswer(
      _input: ReviewHearingAnswerInput<Side>
    ): Promise<HearingAnswerReview> {
      return {
        type: "followup",
        question: "さらに深掘りたい追撃質問",
        reason: "まだ事実が薄い",
      };
    }
  }

  class AlwaysAnswerGateway implements ParticipantResponseGateway {
    readonly calls: string[] = [];
    async waitForResponse(side: "A" | "B"): Promise<string | null> {
      this.calls.push(side);
      return "浅い回答";
    }
    async waitForAnyResponse(): Promise<AnyResponse | null> {
      return null;
    }
  }

  const messageGateway = new FakeMessageGateway();
  const agentB = new AlwaysFollowupAgent("B");
  const answerGateway = new AlwaysAnswerGateway();
  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: agentB,
    },
    new FakeDebateLlmGateway(),
    messageGateway,
    answerGateway,
    0,
    1 // maxHearingFollowups=1 → 初回+追撃1回で打ち切り
  );

  await orchestrator.run(session.id);

  const hearingDms = messageGateway.dms.filter(
    (d) => d.side === "B" && /対話中に確認したいことが出た/.test(d.message)
  );
  assert.equal(
    hearingDms.length,
    2,
    "初回質問 + 追撃1回の計2通で打ち切られる（上限=1）"
  );
  assert.equal(
    answerGateway.calls.filter((s) => s === "B").length,
    2,
    "waitForResponse も2回で止まる（無限追撃にならない）"
  );

  const talks = messageGateway.talks.map((t) => t.message).join("\n");
  assert.match(talks, /追撃質問（1\/1）/, "追撃1回目のアナウンスは出る");
  assert.doesNotMatch(
    talks,
    /追撃質問（2\//,
    "maxHearingFollowups=1 なので2回目の追撃は発火しない"
  );
});

// 核となる不変条件:
// A代理人は B の本音を、B代理人は A の本音を、一切受け取ってはならない。
// これが破れると「感情破壊を防ぐ代理喧嘩」の前提が崩れる。
test("A代理とB代理は互いの本音を知らないまま対話する", async () => {
  const A_SECRET = "Aの本音トークン:ALPHA_SECRET_MARKER";
  const B_SECRET = "Bの本音トークン:BRAVO_SECRET_MARKER";

  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "isolation-session",
    guildId: "guild-iso",
    policy: new SessionPolicy({ maxTurns: 4, maxAppeals: 0 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = A_SECRET;
  session.getParticipant("B").brief.structuredContext = B_SECRET;
  session.getParticipant("A").brief.goal = "Aのゴール:GOAL_A_TOKEN";
  session.getParticipant("B").brief.goal = "Bのゴール:GOAL_B_TOKEN";
  await repository.save(session);

  const agentA = new FakeParticipantAgent("A");
  const agentB = new FakeParticipantAgent("B");
  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    { A: agentA, B: agentB },
    new FakeDebateLlmGateway(),
    new FakeMessageGateway(),
    new FakeParticipantResponseGateway(),
    0
  );

  await orchestrator.run(session.id);

  for (const brief of agentA.receivedBriefs) {
    assert.ok(
      brief.includes(A_SECRET),
      "A代理は自分の本音を必ず受け取っている"
    );
    assert.ok(
      !brief.includes(B_SECRET),
      `A代理にBの本音が混入している: ${brief}`
    );
    assert.ok(
      !brief.includes("GOAL_B_TOKEN"),
      `A代理にBのゴールが混入している: ${brief}`
    );
  }

  for (const brief of agentB.receivedBriefs) {
    assert.ok(
      brief.includes(B_SECRET),
      "B代理は自分の本音を必ず受け取っている"
    );
    assert.ok(
      !brief.includes(A_SECRET),
      `B代理にAの本音が混入している: ${brief}`
    );
    assert.ok(
      !brief.includes("GOAL_A_TOKEN"),
      `B代理にAのゴールが混入している: ${brief}`
    );
  }

  assert.ok(agentA.receivedBriefs.length > 0, "A代理は最低1ターンは発言している");
  assert.ok(agentB.receivedBriefs.length > 0, "B代理は最低1ターンは発言している");
});

// 上告フロー: 勝者が固定のLLMで、敗者Bが第一審→再審→最終審まで異議を出し続ける
class ScriptedJudgeLlmGateway implements LlmGateway {
  readonly calls: JudgeRoundInput[] = [];

  constructor(private readonly judgments: Judgment[]) {}

  async extractBrief(_input: BriefInput): Promise<StructuredBrief> {
    return { structuredContext: "", summary: "" };
  }

  async appendBrief(input: AppendBriefInput): Promise<StructuredBrief> {
    return {
      structuredContext: `${input.currentStructuredContext}\n${input.additionalInput}`,
      summary: input.additionalInput,
    };
  }

  async generateProbe(): Promise<string> {
    return "追加質問";
  }

  async judgeRound(input: JudgeRoundInput): Promise<Judgment> {
    this.calls.push(input);
    const judgment = this.judgments[this.calls.length - 1];
    if (!judgment) {
      throw new Error("判定の台本が尽きました");
    }
    return judgment;
  }

  async generateConsolation(): Promise<string> {
    return "";
  }
}

function makeJudgment(overrides: Partial<Judgment>): Judgment {
  return {
    winner: "A",
    criteria: [],
    totalA: 3,
    totalB: 2,
    summary: "",
    zopa: null,
    wisdom: null,
    angerA: null,
    angerB: null,
    ...overrides,
  };
}

test("敗者が異議を出すと再審AIが前判定と異議を踏まえて再評価する", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "appeal-session",
    guildId: "guild-appeal",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 1, appealTimeoutMs: 1000 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  const messageGateway = new FakeMessageGateway();
  const judgeGateway = new ScriptedJudgeLlmGateway([
    makeJudgment({ winner: "A", summary: "第一審: Aが優勢" }),
    makeJudgment({ winner: "B", summary: "再審: Bの異議を採用して逆転" }),
  ]);
  const appealGateway = new ScriptedAppealGateway([
    { side: "B", response: "第一審で私の主張Xが無視された" },
  ]);

  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: new FakeParticipantAgent("B"),
    },
    judgeGateway,
    messageGateway,
    appealGateway,
    0
  );

  await orchestrator.run(session.id);

  assert.equal(judgeGateway.calls.length, 2, "判定は2回呼ばれる（第一審・再審）");
  assert.equal(judgeGateway.calls[0].courtLevel, "district");
  assert.equal(judgeGateway.calls[0].appeal, null);
  assert.deepEqual(judgeGateway.calls[0].previousJudgments, []);

  assert.equal(judgeGateway.calls[1].courtLevel, "high");
  assert.equal(judgeGateway.calls[1].appeal?.appellantSide, "B");
  assert.equal(
    judgeGateway.calls[1].appeal?.content,
    "第一審で私の主張Xが無視された"
  );
  assert.equal(judgeGateway.calls[1].previousJudgments.length, 1);
  assert.equal(judgeGateway.calls[1].previousJudgments[0].summary, "第一審: Aが優勢");

  const saved = await repository.findById(session.id);
  assert.ok(saved);
  assert.equal(saved.phase, "finished");
  assert.equal(saved.rounds.length, 2);
  assert.equal(saved.rounds[0].courtLevel, "district");
  assert.equal(saved.rounds[1].courtLevel, "high");
  assert.equal(saved.rounds[1].appeal?.content, "第一審で私の主張Xが無視された");

  assert.match(
    messageGateway.dms.find((d) => d.side === "B")?.message || "",
    /異議をDMで送って/
  );
  assert.match(
    messageGateway.talks.map((t) => t.message).join("\n"),
    /B側から異議申し立て/
  );
});

test("異議のタイムアウトで再審は呼ばれずに判定が確定する", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "appeal-timeout",
    guildId: "guild-timeout",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 1, appealTimeoutMs: 1000 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  const messageGateway = new FakeMessageGateway();
  const judgeGateway = new ScriptedJudgeLlmGateway([
    makeJudgment({ winner: "A", summary: "第一審: Aが優勢" }),
  ]);
  // 何も返さない = タイムアウト
  const appealGateway = new ScriptedAppealGateway([null]);

  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: new FakeParticipantAgent("B"),
    },
    judgeGateway,
    messageGateway,
    appealGateway,
    0
  );

  await orchestrator.run(session.id);

  assert.equal(judgeGateway.calls.length, 1, "タイムアウト時は再審は呼ばれない");
  const saved = await repository.findById(session.id);
  assert.ok(saved);
  assert.equal(saved.phase, "finished");
  assert.equal(saved.rounds.length, 1);
  assert.match(
    messageGateway.talks.map((t) => t.message).join("\n"),
    /異議なし。判定が確定した。/
  );
});

test("再審にさらに異議が出れば最終審AIが最終判断する", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "appeal-final",
    guildId: "guild-final",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 2, appealTimeoutMs: 1000 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  const messageGateway = new FakeMessageGateway();
  const judgeGateway = new ScriptedJudgeLlmGateway([
    makeJudgment({ winner: "A", summary: "第一審: Aが優勢" }),
    makeJudgment({ winner: "A", summary: "再審: 異議は採用しない。Aを維持" }),
    makeJudgment({ winner: "B", summary: "最終審: 最終的にBに軍配" }),
  ]);
  // 敗者は第一審でB、再審でもB（A勝ち続けなので）→ 両方で異議を出す
  const appealGateway = new ScriptedAppealGateway([
    { side: "B", response: "第一審は私の論点を誤解している" },
    { side: "B", response: "再審も結局事実を軽視している" },
  ]);

  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: new FakeParticipantAgent("B"),
    },
    judgeGateway,
    messageGateway,
    appealGateway,
    0
  );

  await orchestrator.run(session.id);

  assert.equal(judgeGateway.calls.length, 3, "第一審・再審・最終審で計3回");
  assert.deepEqual(
    judgeGateway.calls.map((c) => c.courtLevel),
    ["district", "high", "supreme"]
  );
  assert.equal(judgeGateway.calls[2].previousJudgments.length, 2);
  assert.equal(
    judgeGateway.calls[2].appeal?.content,
    "再審も結局事実を軽視している"
  );

  const saved = await repository.findById(session.id);
  assert.ok(saved);
  assert.equal(saved.phase, "finished");
  assert.equal(saved.rounds.length, 3);
  assert.deepEqual(
    saved.rounds.map((r) => r.courtLevel),
    ["district", "high", "supreme"]
  );
  assert.equal(saved.rounds[2].judgment?.winner, "B");
});

// 引き分け判定でも上告案内は必ず出る。LLM が malformed JSON を返して winner が
// "draw" にフォールバックした場合もここに当たる。
test("引き分けでも上告案内が出て、どちらからでも異議を受け付ける", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "draw-appeal",
    guildId: "guild-draw",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 1, appealTimeoutMs: 1000 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  const messageGateway = new FakeMessageGateway();
  const judgeGateway = new ScriptedJudgeLlmGateway([
    makeJudgment({ winner: "draw", summary: "第一審: 引き分け" }),
    makeJudgment({ winner: "A", summary: "再審: Aに軍配" }),
  ]);
  // A側が先に異議を出す設定
  const appealGateway = new ScriptedAppealGateway([
    { side: "A", response: "引き分けには納得できない" },
  ]);

  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: new FakeParticipantAgent("B"),
    },
    judgeGateway,
    messageGateway,
    appealGateway,
    0
  );

  await orchestrator.run(session.id);

  // 上告フェーズに必ず入る
  assert.match(
    messageGateway.talks.map((t) => t.message).join("\n"),
    /A・B側に異議申し立ての権利あり/,
    "引き分け時は両側に上告権を案内する"
  );

  // 両方にDMが届いている
  assert.ok(messageGateway.dms.some((d) => d.side === "A" && /異議/.test(d.message)));
  assert.ok(messageGateway.dms.some((d) => d.side === "B" && /異議/.test(d.message)));

  // 再審が呼ばれて appellantSide=A
  assert.equal(judgeGateway.calls.length, 2);
  assert.equal(judgeGateway.calls[1].appeal?.appellantSide, "A");
  assert.equal(
    judgeGateway.calls[1].appeal?.content,
    "引き分けには納得できない"
  );

  const saved = await repository.findById(session.id);
  assert.ok(saved);
  assert.equal(saved.phase, "finished");
  assert.equal(saved.rounds.length, 2);
});

// 早押しDMを取りこぼさないことの保証: waitForResponse / waitForAnyResponse は
// #talk アナウンスや DM 案内を送るより先に登録される必要がある。
test("異議待機リスナーは案内メッセージより先に登録される", async () => {
  const events: string[] = [];

  class OrderedMessageGateway implements MessageGateway {
    async sendDm(side: "A" | "B", _message: string): Promise<void> {
      events.push(`dm:${side}`);
    }
    async sendTalkMessage(
      message: string,
      _speaker: "A" | "B" | "system" = "system"
    ): Promise<void> {
      events.push(`talk:${message.slice(0, 14)}`);
    }
    async sendTyping(): Promise<void> {}
  }

  class OrderedAppealGateway implements ParticipantResponseGateway {
    async waitForResponse(side: "A" | "B"): Promise<string | null> {
      events.push(`wait:${side}`);
      return null;
    }
    async waitForAnyResponse(
      sides: ("A" | "B")[]
    ): Promise<AnyResponse | null> {
      events.push(`waitAny:${sides.join(",")}`);
      return null;
    }
  }

  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "race-session",
    guildId: "guild-race",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 1, appealTimeoutMs: 1000 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  const judgeGateway = new ScriptedJudgeLlmGateway([
    makeJudgment({ winner: "A", summary: "Aの勝ち" }),
  ]);

  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: new FakeParticipantAgent("B"),
    },
    judgeGateway,
    new OrderedMessageGateway(),
    new OrderedAppealGateway(),
    0
  );

  await orchestrator.run(session.id);

  const appealPromptIdx = events.findIndex((e) =>
    e.startsWith("talk:📣")
  );
  const waitIdx = events.findIndex(
    (e) => e.startsWith("wait:") || e.startsWith("waitAny:")
  );

  assert.ok(waitIdx >= 0, "wait が呼ばれている");
  assert.ok(appealPromptIdx >= 0, "異議案内の talk が出ている");
  assert.ok(
    waitIdx < appealPromptIdx,
    `wait は案内より先に登録されるべき (wait=${waitIdx}, prompt=${appealPromptIdx})`
  );
});

// 最終審の finished に到達したことを明示的に告知する
test("最終審で決着したら『これ以上の上告はできない』と告知する", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "supreme-final",
    guildId: "guild-supreme",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 2, appealTimeoutMs: 1000 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  const messageGateway = new FakeMessageGateway();
  const judgeGateway = new ScriptedJudgeLlmGateway([
    makeJudgment({ winner: "A", summary: "地裁" }),
    makeJudgment({ winner: "A", summary: "高裁でも維持" }),
    makeJudgment({ winner: "A", summary: "最終審でも維持" }),
  ]);
  const appealGateway = new ScriptedAppealGateway([
    { side: "B", response: "1回目の異議" },
    { side: "B", response: "2回目の異議" },
  ]);

  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: new FakeParticipantAgent("B"),
    },
    judgeGateway,
    messageGateway,
    appealGateway,
    0
  );

  await orchestrator.run(session.id);

  const talks = messageGateway.talks.map((t) => t.message).join("\n");
  assert.match(
    talks,
    /最終審で決着。これ以上の上告はできない/,
    "最終審の告知がある"
  );

  const saved = await repository.findById(session.id);
  assert.ok(saved);
  assert.equal(saved.phase, "finished");
  assert.equal(saved.rounds.length, 3);
});

// 異議申し立てDMには代理人が生成した提案が含まれ、かつ各代理人は自側の brief しか使わない
test("上告案内DMには代理人の異議材料提案が添えられ、brief の隔離も守られる", async () => {
  const A_SECRET = "APPEAL_ALPHA_SECRET";
  const B_SECRET = "APPEAL_BRAVO_SECRET";

  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "suggestion-session",
    guildId: "guild-suggestion",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 1, appealTimeoutMs: 1000 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = A_SECRET;
  session.getParticipant("B").brief.structuredContext = B_SECRET;
  await repository.save(session);

  const messageGateway = new FakeMessageGateway();
  const judgeGateway = new ScriptedJudgeLlmGateway([
    makeJudgment({ winner: "A", summary: "Aが勝ち" }),
    makeJudgment({ winner: "A", summary: "再審でも維持" }),
  ]);
  const appealGateway = new ScriptedAppealGateway([
    { side: "B", response: "納得できない" },
  ]);

  const agentA = new FakeParticipantAgent("A");
  const agentB = new FakeParticipantAgent("B");

  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    { A: agentA, B: agentB },
    judgeGateway,
    messageGateway,
    appealGateway,
    0
  );

  await orchestrator.run(session.id);

  // 上告案内DM（B側が敗者）に提案セクションが入っていること
  const appealDm = messageGateway.dms.find(
    (d) => d.side === "B" && /異議をDMで送って/.test(d.message)
  );
  assert.ok(appealDm, "B向けの上告案内DMが存在する");
  assert.match(appealDm.message, /代理人からの提案/, "提案セクションがDMに含まれる");
  assert.match(appealDm.message, /B代理からの提案/, "B代理からの提案が入っている");

  // 隔離: B代理の suggestAppealPoints は B の brief のみ受け取り、Aのbriefは混入しない
  assert.equal(agentB.receivedAppealInputs.length, 1);
  assert.match(agentB.receivedAppealInputs[0].brief, /APPEAL_BRAVO_SECRET/);
  assert.doesNotMatch(
    agentB.receivedAppealInputs[0].brief,
    /APPEAL_ALPHA_SECRET/,
    "B代理にAのbriefが混入していない"
  );

  // A は勝者なので suggestAppealPoints は呼ばれない
  assert.equal(
    agentA.receivedAppealInputs.length,
    0,
    "勝者側の代理人には異議提案は要求されない"
  );
});

// SPEC §6.9 / P1-17: 最終審（または上告放棄）で敗者が確定したら、
// 敗者だけに振り返りメッセージを DM で送る。
// 勝者には送らず、引き分け時はどちらにも送らない。
test("敗者が確定したらConsolationDMが敗者にだけ届く（P1-17）", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "consolation-session",
    guildId: "guild-consolation",
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 0 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの本音:LOSER_CONTEXT_TOKEN";
  await repository.save(session);

  // 判決履歴を loserContext と一緒に受け取ったことを検証するためにキャプチャする。
  class ConsolationCapturingGateway extends FakeDebateLlmGateway {
    readonly calls: ConsolationInput[] = [];
    override async generateConsolation(
      input: ConsolationInput
    ): Promise<string> {
      this.calls.push(input);
      return "今回は悔しいかもしれないが、次に活かせる観点がある。";
    }
  }

  const messageGateway = new FakeMessageGateway();
  const llmGateway = new ConsolationCapturingGateway();
  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: new FakeParticipantAgent("B"),
    },
    llmGateway,
    messageGateway,
    new FakeParticipantResponseGateway(),
    0
  );

  await orchestrator.run(session.id);

  // 敗者（B）に Consolation DM が届いている
  const consolationDm = messageGateway.dms.find(
    (d) => d.side === "B" && /最後にひとこと/.test(d.message)
  );
  assert.ok(consolationDm, "敗者（B）に Consolation DM が届く");
  assert.match(
    consolationDm.message,
    /今回は悔しいかもしれないが、次に活かせる観点がある。/,
    "LLM が生成した本文が DM に含まれる"
  );

  // 勝者（A）には Consolation DM は届かない
  assert.ok(
    !messageGateway.dms.some(
      (d) => d.side === "A" && /最後にひとこと/.test(d.message)
    ),
    "勝者側にはConsolationは送らない"
  );

  // LLM には敗者の brief と判決履歴が渡される
  assert.equal(llmGateway.calls.length, 1);
  assert.match(llmGateway.calls[0].loserContext, /LOSER_CONTEXT_TOKEN/);
  assert.equal(llmGateway.calls[0].judgmentHistory.length, 1);
  assert.match(llmGateway.calls[0].judgmentHistory[0], /A側がやや優勢/);
});

// SPEC §6.9 / P1-17: 引き分け時は誰が「敗者」か決まっていないので
// Consolation DM は送らない。
test("引き分けでは誰にもConsolationDMを送らない（P1-17）", async () => {
  const repository = new InMemorySessionRepository();
  const session = new Session({
    id: "draw-no-consolation",
    guildId: "guild-draw-no-cons",
    // maxAppeals=0 で draw でもそのまま finished に流れる
    policy: new SessionPolicy({ maxTurns: 2, maxAppeals: 0 }),
  });
  session.phase = "ready";
  session.getParticipant("A").phase = "ready";
  session.getParticipant("B").phase = "ready";
  session.getParticipant("A").brief.structuredContext = "Aの背景";
  session.getParticipant("B").brief.structuredContext = "Bの背景";
  await repository.save(session);

  const messageGateway = new FakeMessageGateway();
  const judgeGateway = new ScriptedJudgeLlmGateway([
    makeJudgment({ winner: "draw", summary: "引き分け" }),
  ]);
  const orchestrator = new DebateOrchestrator(
    repository,
    new SessionStateMachine(),
    {
      A: new FakeParticipantAgent("A"),
      B: new FakeParticipantAgent("B"),
    },
    judgeGateway,
    messageGateway,
    new FakeParticipantResponseGateway(),
    0
  );

  await orchestrator.run(session.id);

  // どちらの側にも Consolation DM は来ない
  assert.ok(
    !messageGateway.dms.some((d) => /最後にひとこと/.test(d.message)),
    "引き分けではConsolationを一切送らない"
  );

  const saved = await repository.findById(session.id);
  assert.ok(saved);
  assert.equal(saved.phase, "finished");
  assert.equal(saved.getCurrentRound().judgment?.winner, "draw");
});
