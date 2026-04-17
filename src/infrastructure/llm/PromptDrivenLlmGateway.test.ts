import test from "node:test";
import assert from "node:assert/strict";
import { PromptDrivenLlmGateway } from "./PromptDrivenLlmGateway.js";
import type { LLMClient, LLMMessage, LLMResponse } from "../../llm/provider.js";

class QueueLlmClient implements LLMClient {
  constructor(private readonly responses: string[]) {}

  async chat(_messages: LLMMessage[]): Promise<LLMResponse> {
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("LLMレスポンスが不足しています。");
    }

    return { content };
  }
}

test("追加質問は最初の1問だけに絞る", async () => {
  const gateway = new PromptDrivenLlmGateway(
    new QueueLlmClient([
      "恋人に『それは現実的じゃない』って言われたらどう答える？\n恋人に『対等じゃないよね？』って返されたらどう言う？",
    ])
  );

  const probe = await gateway.generateProbe("■案件の理解:\nビーバーと暮らしたい");

  assert.equal(
    probe,
    "恋人に『それは現実的じゃない』って言われたらどう答える？"
  );
});

test("確認文から追加質問の行を落とす", async () => {
  const gateway = new PromptDrivenLlmGateway(
    new QueueLlmClient([
      "■案件の理解:\nビーバーと暮らしたい\n■インタレスト:\n対等でいたい\n■武器:\n本気度\n■弱点:\n不明\n■NGワード:\nなし",
      "ビーバーとの共同生活を本気で提案したいんだな。\n対等な関係じゃないと嫌なんだよな。\n相手は誰？\n恋人に『固定観念が強い』って返されたらどう言う？",
    ])
  );

  const brief = await gateway.extractBrief({
    rawInputs: ["ビーバーとの共同生活を真剣に提案したい"],
  });

  assert.equal(
    brief.summary,
    "ビーバーとの共同生活を本気で提案したいんだな。\n\n対等な関係じゃないと嫌なんだよな。"
  );
});

test("judgeRound: LLM の winner が criteria 合計と矛盾していたら合計側を正とする", async () => {
  // LLM は winner="A" と言うが、criteria 合計は B の方が上。
  // → parseJudgment が B を正解として修正する。
  const gateway = new PromptDrivenLlmGateway(
    new QueueLlmClient([
      JSON.stringify({
        criteria: [
          { name: "論理", scoreA: 2, scoreB: 4, reason: "Bが一貫" },
          { name: "根拠", scoreA: 2, scoreB: 4, reason: "B具体的" },
          { name: "反論", scoreA: 3, scoreB: 4, reason: "B応答" },
        ],
        totalA: 15,
        totalB: 5,
        winner: "A",
        summary: "Aの勝ち（と書いてあるがスコアは逆）",
      }),
    ])
  );

  const judgment = await gateway.judgeRound({
    courtLevel: "district",
    contextA: "Aの背景",
    contextB: "Bの背景",
    goalA: null,
    goalB: null,
    dialogue: [],
    previousJudgments: [],
    appeal: null,
  });

  assert.equal(judgment.winner, "B", "合計に従って B が勝者");
  assert.equal(judgment.totalA, 7, "criteria.scoreA の合計");
  assert.equal(judgment.totalB, 12, "criteria.scoreB の合計");
});

test("judgeRound: scoreA/scoreB が文字列でも 0-5 の整数に正規化する", async () => {
  const gateway = new PromptDrivenLlmGateway(
    new QueueLlmClient([
      JSON.stringify({
        criteria: [
          { name: "論理", scoreA: "5", scoreB: 10, reason: "（scoreBは範囲外）" },
          { name: "根拠", scoreA: "not a number", scoreB: -3, reason: "（両方不正）" },
        ],
        totalA: 99,
        totalB: 99,
        winner: "A",
        summary: "",
      }),
    ])
  );

  const judgment = await gateway.judgeRound({
    courtLevel: "district",
    contextA: "",
    contextB: "",
    goalA: null,
    goalB: null,
    dialogue: [],
    previousJudgments: [],
    appeal: null,
  });

  assert.equal(judgment.criteria[0].scoreA, 5);
  assert.equal(judgment.criteria[0].scoreB, 5, "10 は 5 にクランプ");
  assert.equal(judgment.criteria[1].scoreA, 0, "文字列は 0");
  assert.equal(judgment.criteria[1].scoreB, 0, "負値は 0");
  assert.equal(judgment.totalA, 5);
  assert.equal(judgment.totalB, 5);
  assert.equal(judgment.winner, "draw", "totalが同じなら draw");
});

test("確認文が拒絶的に崩れた時は構造化ブリーフから安全に組み直す", async () => {
  const gateway = new PromptDrivenLlmGateway(
    new QueueLlmClient([
      "■案件の理解:\n恋人にビーバーとの共同生活を真剣に提案したい。まだ衝突は起きていないが、対等な関係として理解されるか不安を抱えている。\n■インタレスト:\n対等なパートナーとして扱われたい\n■武器:\n農業で食料を提供できる具体案がある\n■弱点:\n恋人の反応はまだ不明\n■NGワード:\n未確認",
      "【案件理解不可】\n動物愛護団体への企画提案か、精神科への相談案件だ。\n【再依頼せよ】\n出直せ。",
    ])
  );

  const brief = await gateway.extractBrief({
    rawInputs: ["恋人にビーバーとの共同生活について真剣に提案したい"],
  });

  assert.equal(
    brief.summary,
    "恋人にビーバーとの共同生活を真剣に提案したい。まだ衝突は起きていないが、対等な関係として理解されるか不安を抱えている。\n\nお前が大事にしてるのは対等なパートナーとして扱われたいってことだよな。\n\n今の武器として見えてるのは、農業で食料を提供できる具体案があるって点だ。"
  );
});
