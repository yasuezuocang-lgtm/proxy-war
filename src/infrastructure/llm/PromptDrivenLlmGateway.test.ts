import test from "node:test";
import assert from "node:assert/strict";
import { PromptDrivenLlmGateway } from "./PromptDrivenLlmGateway.js";
import type { LLMClient, LLMMessage, LLMResponse } from "../../llm/provider.js";

class QueueLlmClient implements LLMClient {
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

test("追加質問は最初の1問だけに絞る", async () => {
  const gateway = new PromptDrivenLlmGateway(
    new QueueLlmClient([
      "恋人に『それは現実的じゃない』って言われたらどう答える？\n恋人に『対等じゃないよね？』って返されたらどう言う？",
    ])
  );

  const probe = await gateway.generateProbe({
    side: "A",
    structuredContext: "■案件の理解:\nビーバーと暮らしたい",
  });

  assert.equal(
    probe,
    "恋人に『それは現実的じゃない』って言われたらどう答える？"
  );
});

test("extractBrief はDMログの時系列訂正を優先する契約を LLM に渡す", async () => {
  const client = new QueueLlmClient([
    "■案件の理解:\n訂正を踏まえて再整理した。\n■ストーリーライン:\n1. 最新の本音を中心に置く\n■インタレスト:\n最新の本音\n■武器:\n訂正内容\n■弱点:\n不明\n■NGワード:\nなし",
    "最新の訂正を踏まえて整理した。",
  ]);
  const gateway = new PromptDrivenLlmGateway(client);

  await gateway.extractBrief({
    side: "A",
    rawInputs: [
      "ビーバーと共存したい。",
      "ビーバーと共存じゃなく搾取したいのが本音。",
    ],
  });

  const extractSystem = client.messages[0]?.[0]?.content || "";
  const extractUser = client.messages[0]?.[1]?.content || "";

  assert.match(extractSystem, /入力は時系列のDMログ/);
  assert.match(extractSystem, /後の発言を正/);
  assert.match(extractSystem, /全部見直せ/);
  assert.match(extractUser, /ビーバーと共存じゃなく搾取したいのが本音/);
});

test("appendBrief は訂正優先とストーリーライン分割の契約を LLM に渡す", async () => {
  const client = new QueueLlmClient([
    "■案件の理解:\n恋人は言葉では一定尊重したが、態度では軽く見られているように感じた。\n■ストーリーライン:\n1. ビーバー共存を本気で考えている\n2. 恋人は表面上は尊重した\n3. 態度から軽蔑を感じた\n4. 法律や安全性は弱点\n5. 価値観を理解してほしい\n■インタレスト:\n価値観を変人扱いせず理解してほしい\n■武器:\n表面上の尊重と態度のギャップ\n■弱点:\n法律や安全性の詰めが弱い\n■NGワード:\n頭おかしい、病気",
    "お前はビーバーとの共存生活を本気で考えている。恋人は言葉では一応尊重してくれたけど、態度からは軽く見られている感じがして、それが一番きつかったんだな。",
    "お前の修正どおり、恋人に変なことと言われたわけじゃない。一応尊重はされたけど、態度ではものすごい軽蔑を感じたのが一番引っかかってるんだな。",
  ]);
  const gateway = new PromptDrivenLlmGateway(client);

  await gateway.appendBrief({
    side: "A",
    currentStructuredContext:
      "■案件の理解:\n恋人に「また変なこと」と言われて一蹴された。\n■インタレスト:\n不明\n■武器:\n不明\n■弱点:\n不明\n■NGワード:\n未確認",
    additionalInput:
      "変なこととは言われてない。一応尊重はしてくれたよ。でも表面的で態度ではものすごい軽蔑感じたの。",
  });

  const appendSystem = client.messages[0]?.[0]?.content || "";
  const appendUser = client.messages[0]?.[1]?.content || "";
  const briefSystem = client.messages[1]?.[0]?.content || "";

  assert.match(appendSystem, /訂正は現在の分析より優先/);
  assert.match(appendSystem, /Xとは言われてない/);
  assert.match(appendSystem, /相手が実際に言った言葉/);
  assert.match(appendUser, /現在の分析より優先/);
  assert.match(appendUser, /変なこととは言われてない/);
  assert.match(briefSystem, /■ストーリーライン/);
  assert.match(briefSystem, /一蹴された/);
});

test("appendBrief は価値観が反転した最新本音を汎用ルールで構造化ブリーフと確認文生成に残す", async () => {
  const client = new QueueLlmClient([
    "■案件の理解:\nビーバーと対等なパートナーシップを作りたい。\n■ストーリーライン:\n1. 対等な共存を目指す\n■インタレスト:\n対等でいたい\n■武器:\n非搾取の理想\n■弱点:\n不明\n■NGワード:\n未確認",
    "お前はビーバーと対等なパートナーシップを作りたいんだな。",
    "お前の最新の本音は、ビーバーと対等に共存したいって綺麗な話じゃなくて、ビーバーから搾取して幸せに暮らしたいってことなんだな。\n\nその本音を言ったうえで、恋人に表面的には尊重されても態度では軽蔑を感じたから、まともな話し相手として扱われてない感じが引っかかってる。",
  ]);
  const gateway = new PromptDrivenLlmGateway(client);

  const brief = await gateway.appendBrief({
    side: "A",
    currentStructuredContext:
      "■案件の理解:\nビーバーと対等なパートナーシップを作りたい。\n■インタレスト:\n対等でいたい\n■武器:\n非搾取の理想\n■弱点:\n不明\n■NGワード:\n未確認",
    additionalInput: "いや本音を言えばビーバーから搾取して幸せに暮らしたい。",
  });

  const appendSystem = client.messages[0]?.[0]?.content || "";
  const summaryUser = client.messages[1]?.[1]?.content || "";
  const rethinkSystem = client.messages[2]?.[0]?.content || "";
  const rethinkUser = client.messages[2]?.[1]?.content || "";

  assert.match(appendSystem, /価値観・目的の反転/);
  assert.match(appendSystem, /倫理的に補正するな/);
  assert.match(appendSystem, /直近修正の具体語/);
  assert.doesNotMatch(appendSystem, /搾取したい/);
  assert.match(brief.structuredContext, /■最新の訂正・追加発言:/);
  assert.match(
    brief.structuredContext,
    /いや本音を言えばビーバーから搾取して幸せに暮らしたい。/
  );
  assert.match(summaryUser, /■最新の訂正・追加発言:/);
  assert.match(summaryUser, /ビーバーから搾取して幸せに暮らしたい/);
  assert.match(rethinkSystem, /確認文全体を再考/);
  assert.match(rethinkSystem, /直近修正の具体語/);
  assert.doesNotMatch(rethinkSystem, /搾取したい/);
  assert.match(rethinkUser, /前回確認文/);
  assert.match(brief.summary, /^最新の訂正では/);
  assert.match(
    brief.summary,
    /いや本音を言えばビーバーから搾取して幸せに暮らしたい。/
  );
  assert.match(brief.summary, /ビーバーから搾取して幸せに暮らしたい/);
});

test("確認文から追加質問の行を落とす", async () => {
  const gateway = new PromptDrivenLlmGateway(
    new QueueLlmClient([
      "■案件の理解:\nビーバーと暮らしたい\n■インタレスト:\n対等でいたい\n■武器:\n本気度\n■弱点:\n不明\n■NGワード:\nなし",
      "ビーバーとの共同生活を本気で提案したいんだな。\n対等な関係じゃないと嫌なんだよな。\n相手は誰？\n恋人に『固定観念が強い』って返されたらどう言う？",
    ])
  );

  const brief = await gateway.extractBrief({
    side: "A",
    rawInputs: ["ビーバーとの共同生活を真剣に提案したい"],
  });

  assert.equal(
    brief.summary,
    "ビーバーとの共同生活を本気で提案したいんだな。\n\n対等な関係じゃないと嫌なんだよな。"
  );
});

// migration-plan §3 Step 6: judgeRound 実装は JudgeAgent に一本化済み。
// 対応するパース正規化テストは src/infrastructure/agents/JudgeAgent.test.ts へ移管。

test("確認文が拒絶的に崩れた時は構造化ブリーフから安全に組み直す", async () => {
  const gateway = new PromptDrivenLlmGateway(
    new QueueLlmClient([
      "■案件の理解:\n恋人にビーバーとの共同生活を真剣に提案したい。まだ衝突は起きていないが、対等な関係として理解されるか不安を抱えている。\n■インタレスト:\n対等なパートナーとして扱われたい\n■武器:\n農業で食料を提供できる具体案がある\n■弱点:\n恋人の反応はまだ不明\n■NGワード:\n未確認",
      "【案件理解不可】\n動物愛護団体への企画提案か、精神科への相談案件だ。\n【再依頼せよ】\n出直せ。",
    ])
  );

  const brief = await gateway.extractBrief({
    side: "A",
    rawInputs: ["恋人にビーバーとの共同生活について真剣に提案したい"],
  });

  assert.equal(
    brief.summary,
    "恋人にビーバーとの共同生活を真剣に提案したい。まだ衝突は起きていないが、対等な関係として理解されるか不安を抱えている。\n\nお前が大事にしてるのは対等なパートナーとして扱われたいってことだよな。\n\n今の武器として見えてるのは、農業で食料を提供できる具体案があるって点だ。"
  );
});
