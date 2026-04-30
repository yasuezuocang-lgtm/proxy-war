import test from "node:test";
import assert from "node:assert/strict";
import { JudgeAgent } from "./JudgeAgent.js";
import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
} from "../../llm/provider.js";
import type { JudgeRoundInput } from "../../application/ports/LlmGateway.js";
import type { Judgment } from "../../domain/entities/Judgment.js";

class CapturingLlmClient implements LLMClient {
  readonly messages: LLMMessage[][] = [];

  constructor(private readonly responses: string[]) {}

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    this.messages.push(messages);
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("LLMレスポンスが不足しています。");
    }
    return { content };
  }
}

const BASE_INPUT: JudgeRoundInput = {
  courtLevel: "district",
  contextA: "Aの背景トークン:ALPHA",
  contextB: "Bの背景トークン:BRAVO",
  goalA: "謝ってほしい",
  goalB: "放っておいてほしい",
  dialogue: [
    { speaker: "A", message: "Aの発言" },
    { speaker: "B", message: "Bの発言" },
  ],
  previousJudgments: [],
  appeal: null,
};

test("JudgeAgent は審判官の人格メタデータを保持する", () => {
  const agent = new JudgeAgent(new CapturingLlmClient([]));
  assert.equal(agent.personality.id, "judge-agent-v1");
  assert.equal(agent.personality.label, "審判官");
  assert.match(
    agent.personality.styleNotes || "",
    /丁寧|敬語|裁判官/,
    "審判は丁寧調である旨が styleNotes に書かれている"
  );
});

test("judgeRound(district) は第一審プロンプトを丁寧調で組み立て、対話と背景を渡す", async () => {
  const llm = new CapturingLlmClient([
    JSON.stringify({
      criteria: [
        { name: "論理", scoreA: 4, scoreB: 3, reason: "A優位" },
        { name: "根拠", scoreA: 3, scoreB: 4, reason: "B優位" },
        { name: "建設性", scoreA: 3, scoreB: 2, reason: "A少し優位" },
      ],
      totalA: 10,
      totalB: 9,
      winner: "A",
      summary: "接戦",
      zopa: "週1回話し合う",
      wisdom: "二人固有の洞察",
      angerA: "Aの怒り",
      angerB: "Bの怒り",
    }),
  ]);
  const agent = new JudgeAgent(llm);

  const judgment = await agent.judgeRound(BASE_INPUT);

  const system = llm.messages[0]?.[0]?.content || "";
  assert.match(system, /です|ください/, "丁寧調で書かれている");
  assert.match(system, /地方裁判所|第一審/, "第一審の審理であることが明記");
  assert.doesNotMatch(system, /お前/, "A/B代理人のタメ口と明確に違う");
  assert.doesNotMatch(system, /しろ$/m, "命令口調ではない");

  const user = llm.messages[0]?.[1]?.content || "";
  assert.match(user, /ALPHA/, "A側の背景が user prompt に含まれる");
  assert.match(user, /BRAVO/, "B側の背景が user prompt に含まれる");
  assert.match(user, /Aの発言[\s\S]*Bの発言/, "対話が順に user prompt に含まれる");
  assert.doesNotMatch(user, /過去の審理記録/, "第一審では過去判決セクションが出ない");

  assert.equal(judgment.winner, "A");
  assert.equal(judgment.totalA, 10);
  assert.equal(judgment.totalB, 9);
  assert.equal(judgment.angerA, "Aの怒り");
  assert.equal(judgment.angerB, "Bの怒り");
});

test("judgeRound(high) は再審プロンプトで、過去判決と異議を user prompt に含める", async () => {
  const llm = new CapturingLlmClient([
    JSON.stringify({
      criteria: [{ name: "項目", scoreA: 3, scoreB: 4, reason: "B優位" }],
      winner: "B",
      summary: "B逆転",
    }),
  ]);
  const agent = new JudgeAgent(llm);

  const districtJudgment: Judgment = {
    winner: "A",
    criteria: [],
    totalA: 10,
    totalB: 8,
    summary: "A勝利の総評",
    zopa: null,
    wisdom: null,
    angerA: null,
    angerB: null,
  };

  await agent.judgeRound({
    ...BASE_INPUT,
    courtLevel: "high",
    previousJudgments: [districtJudgment],
    appeal: {
      appellantSide: "B",
      content: "B側の異議理由本文",
      createdAt: Date.now(),
    },
  });

  const system = llm.messages[0]?.[0]?.content || "";
  assert.match(system, /高等裁判所|再審/, "再審の立場が system に明記");
  assert.match(system, /前審/, "前審を踏まえる指示が入る");

  const user = llm.messages[0]?.[1]?.content || "";
  assert.match(user, /過去の審理記録/, "過去判決が user prompt に含まれる");
  assert.match(user, /A勝利の総評/, "第一審の総評が user prompt に含まれる");
  assert.match(user, /B側からの異議/, "異議セクションが user prompt に含まれる");
  assert.match(user, /B側の異議理由本文/, "異議本文が user prompt に含まれる");
});

test("judgeRound(supreme) は最終審プロンプトで、過去判決の件数を system に反映する", async () => {
  const llm = new CapturingLlmClient([
    JSON.stringify({
      criteria: [{ name: "項目", scoreA: 3, scoreB: 3, reason: "互角" }],
      winner: "draw",
      summary: "最終決着",
    }),
  ]);
  const agent = new JudgeAgent(llm);

  const prev: Judgment = {
    winner: "A",
    criteria: [],
    totalA: 10,
    totalB: 8,
    summary: "",
    zopa: null,
    wisdom: null,
    angerA: null,
    angerB: null,
  };

  await agent.judgeRound({
    ...BASE_INPUT,
    courtLevel: "supreme",
    previousJudgments: [prev, prev],
  });

  const system = llm.messages[0]?.[0]?.content || "";
  assert.match(system, /最終審|最高裁/, "最終審の立場が system に明記");
  assert.match(system, /過去2件/, "過去判決の件数が system に反映");
});

test("上告審では過去判決を踏まえる旨の指示が system prompt に入る", async () => {
  const districtJudgment: Judgment = {
    winner: "A",
    criteria: [],
    totalA: 10,
    totalB: 6,
    summary: "第一審 A勝利の総評本文",
    zopa: null,
    wisdom: null,
    angerA: null,
    angerB: null,
  };
  const highJudgment: Judgment = {
    winner: "A",
    criteria: [],
    totalA: 9,
    totalB: 7,
    summary: "再審 A維持の総評本文",
    zopa: null,
    wisdom: null,
    angerA: null,
    angerB: null,
  };

  // 高裁（再審）
  {
    const llm = new CapturingLlmClient([
      JSON.stringify({
        criteria: [{ name: "項目", scoreA: 3, scoreB: 4, reason: "B優位" }],
        winner: "B",
        summary: "逆転",
      }),
    ]);
    const agent = new JudgeAgent(llm);
    await agent.judgeRound({
      ...BASE_INPUT,
      courtLevel: "high",
      previousJudgments: [districtJudgment],
      appeal: {
        appellantSide: "B",
        content: "第一審で私の主張が軽視された",
        createdAt: Date.now(),
      },
    });

    const system = llm.messages[0]?.[0]?.content || "";
    const user = llm.messages[0]?.[1]?.content || "";
    assert.match(
      system,
      /前審の判定根拠を読み込/,
      "高裁 system: 前審の判定根拠を読めと明記",
    );
    assert.match(
      system,
      /前審に引きずられることなく|前審を無視することもなく/,
      "高裁 system: 前審を踏まえつつ独立判断する指示が入る",
    );
    assert.match(user, /第一審 A勝利の総評本文/, "高裁 user: 前審総評が渡る");
  }

  // 最高裁（最終審）
  {
    const llm = new CapturingLlmClient([
      JSON.stringify({
        criteria: [{ name: "項目", scoreA: 3, scoreB: 3, reason: "互角" }],
        winner: "draw",
        summary: "最終",
      }),
    ]);
    const agent = new JudgeAgent(llm);
    await agent.judgeRound({
      ...BASE_INPUT,
      courtLevel: "supreme",
      previousJudgments: [districtJudgment, highJudgment],
      appeal: {
        appellantSide: "B",
        content: "再審も事実を軽視している",
        createdAt: Date.now(),
      },
    });

    const system = llm.messages[0]?.[0]?.content || "";
    const user = llm.messages[0]?.[1]?.content || "";
    assert.match(
      system,
      /第一審・再審の両判定[\s\S]*読み込/,
      "最高裁 system: 第一審と再審の両方を読めと明記",
    );
    assert.match(
      system,
      /過去2件の判定の矛盾や一貫性を精査/,
      "最高裁 system: 過去判決件数と一貫性チェック指示",
    );
    assert.match(user, /第一審 A勝利の総評本文/, "最高裁 user: 第一審総評が渡る");
    assert.match(user, /再審 A維持の総評本文/, "最高裁 user: 再審総評が渡る");
  }
});

test("parseJudgment: winner は criteria 合計から計算する（LLM winner は無視）", async () => {
  const llm = new CapturingLlmClient([
    JSON.stringify({
      criteria: [
        { name: "項目1", scoreA: 5, scoreB: 1, reason: "" },
        { name: "項目2", scoreA: 4, scoreB: 2, reason: "" },
      ],
      winner: "B",
      totalA: 9,
      totalB: 3,
      summary: "",
    }),
  ]);
  const agent = new JudgeAgent(llm);
  const judgment = await agent.judgeRound(BASE_INPUT);

  assert.equal(judgment.winner, "A", "合計から A 勝ちと計算される");
  assert.equal(judgment.totalA, 9);
  assert.equal(judgment.totalB, 3);
});

test("parseJudgment: criteria が空なら LLM の winner を fallback で使う", async () => {
  const llm = new CapturingLlmClient([
    JSON.stringify({
      criteria: [],
      winner: "draw",
      summary: "引き分け",
    }),
  ]);
  const agent = new JudgeAgent(llm);
  const judgment = await agent.judgeRound(BASE_INPUT);

  assert.equal(judgment.winner, "draw");
  assert.equal(judgment.totalA, 0);
  assert.equal(judgment.totalB, 0);
});

test("parseJudgment: 不正な JSON でも Judgment を返す（フォールバック総評）", async () => {
  const llm = new CapturingLlmClient(["LLMが壊れた出力で JSON ではない"]);
  const agent = new JudgeAgent(llm);
  const judgment = await agent.judgeRound(BASE_INPUT);

  assert.equal(judgment.winner, "draw");
  assert.equal(judgment.criteria.length, 0);
  assert.ok(
    judgment.summary.length > 0,
    "フォールバック総評が空にならない"
  );
});

test("parseJudgment: scoreA/scoreB は 0-5 の整数に丸められる", async () => {
  const llm = new CapturingLlmClient([
    JSON.stringify({
      criteria: [
        { name: "範囲外", scoreA: 10, scoreB: -2, reason: "" },
        { name: "小数", scoreA: 3.6, scoreB: 2.4, reason: "" },
      ],
      summary: "",
    }),
  ]);
  const agent = new JudgeAgent(llm);
  const judgment = await agent.judgeRound(BASE_INPUT);

  assert.equal(judgment.criteria[0].scoreA, 5);
  assert.equal(judgment.criteria[0].scoreB, 0);
  assert.equal(judgment.criteria[1].scoreA, 4);
  assert.equal(judgment.criteria[1].scoreB, 2);
});
