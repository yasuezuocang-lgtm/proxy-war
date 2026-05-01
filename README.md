# proxy-war

**ケンカしている 2 人のかわりに、AI が代わりに話し合ってくれる Discord Bot。**

直接ぶつかると傷が深くなるとき、AI を間に挟んで「お互いの言い分」を冷静に整理する。最後に審判 AI が落とし所まで提案します。

---

## こういう時に使う

- 家族と「家事の分担」でモヤモヤしているけど、面と向かうと感情的になってしまう
- 友達と小さな誤解があるけど、自分から切り出すのは気まずい
- カップルで何度も同じことで揉めて、毎回うやむやに終わる
- 一度ちゃんと整理して、お互いの気持ちを言語化したい

直接話す勇気が出ない時の「ワンクッション」として使うイメージです。

---

## 使ってる時に何が起きるか

各自がそれぞれの Bot に DM で本音を送ると、Bot 同士が共有チャンネルで代わりに議論し、審判 AI が判定を出します。

```
あなた  ──DM──> Bot A ─┐
                        ├──> #talk チャンネルで Bot 同士が議論
相手    ──DM──> Bot B ─┘
                                 ↓
                            審判 AI が判定
```

### 流れの例（家事の分担で揉めているケース）

1. **本音を Bot に送る (DM)**
   > あなた → Bot A: 「毎日 21 時まで仕事してるのに、帰ってからも食器洗いまで自分。さすがに不公平」
   > 相手 → Bot B: 「自分も家事はやってる。料理は全部担当してる」

2. **Bot がそれぞれの言い分を要約・確認**
   > Bot A → あなた: 「労働時間とのバランスで、家事の負担が偏っているのが不満。これで合ってる？」

3. **共有チャンネルで Bot 同士が代理で議論**
   > 🤖 A: 「料理の負担は認める。ただ食器洗いまで一手に引き受けるのは時間的に厳しい」
   > 🤖 B: 「料理は買い物・献立決めまで含むので作業量は同等のはず」

4. **審判 AI が落とし所を提案**
   > 「料理担当者は食器洗いを免除。代わりに掃除を週 2 で分担。両者の負担時間が均等になる配分」

直接ケンカするより、お互いの主張が整理されて見えます。

---

## 試すには

### 必要なもの

- Node.js 20 以上
- Discord アカウント
- LLM API キー (Anthropic / OpenAI / Gemini / OpenRouter / Groq のいずれか 1 つ)

### Step 1. ダウンロードしてインストール

```bash
git clone https://github.com/yasuezuocang-lgtm/proxy-war.git
cd proxy-war
npm install
```

### Step 2. Discord Bot を 2 つ作る

[Discord Developer Portal](https://discord.com/developers/applications) で **2 つ** の Bot アプリケーションを作成。

各 Bot で以下を設定:

1. 「New Application」→ 名前を付けて作成 (**A 側と B 側で別の名前にする**。同じ名前だと DM が混線します)
2. Bot タブで **Token** を取得
3. **Message Content Intent** を ON
4. OAuth2 → URL Generator で招待 URL を作成 (`bot` スコープ + Send Messages, Read Message History, View Channels)

両方の Bot を **同じサーバー** に招待します。

### Step 3. セットアップウィザード

```bash
npx tsx src/setup.ts
```

聞かれたものを順番に入力:
- Bot A / Bot B のトークン
- 共有サーバーの Guild ID
- LLM プロバイダーと API キー

### Step 4. チャンネル作成

```bash
npm run setup:channels
```

サーバーに `#talk` チャンネルが自動作成されます。

### Step 5. 起動

```bash
npm run dev
```

これで準備完了。Bot A / Bot B にそれぞれ DM を送ると対話が始まります。

---

## 使い方

| 操作 | やること |
|---|---|
| 始める | Bot A / Bot B にそれぞれ本音を DM |
| 確認・修正 | Bot から「これで合ってる？」と聞かれたら答える |
| ゴール設定 (任意) | 「謝ってほしい」「分担を見直したい」など目的があれば伝える |
| 議論を見る | サーバーの `#talk` チャンネルを開く |
| 途中で質問が来たら | Bot からの追加ヒアリングに DM で答える |
| 結果を見る | 審判 AI の判定が `#talk` に流れる |
| 異議申し立て | 結果に納得いかない側は上告できる |
| やり直す | Bot に `リセット` と DM すると新しい対話を始められる |

### 進め方の推奨

片方ずつ順に進めるのが安定します。

1. 先発が Bot に本音を DM
2. Bot からの「これで合ってる？」に答えて要約を確認
3. ゴールを設定 (任意)
4. 「相手の準備待ち」状態に切り替わる
5. ここで後発に「自分も Bot に DM 送って」と声をかける
6. 後発が同じ手順を踏む → 揃ったら自動で対話開始

困った時は、Bot に `help` と DM すると、今できる操作を教えてくれます。それでも進まない時は `リセット` で最初からやり直せます。

---

## 設定

`.env` で LLM モデルを切り替えできます。

| プロバイダー | デフォルトモデル |
|---|---|
| Anthropic | claude-sonnet-4-20250514 |
| OpenAI | gpt-4o |
| Gemini | gemini-2.0-flash |
| OpenRouter | anthropic/claude-sonnet-4-20250514 |
| Groq | llama-3.3-70b-versatile |

`LLM_MODEL` を書き換えれば任意のモデルに変更可能。

---

## 中の構造 (エンジニア向け)

A 側・B 側を完全分離した 5 層構成。

```
src/
  presentation/    Discord SDK 連携・メッセージ整形
  application/
    coordinators/  DebateCoordinator (議論の司会)
    usecases/      Start / ProcessAgentTurn / SubmitHearingAnswer / JudgeRound 等
    services/      SessionStateMachine / SessionRestorer / SessionTimeoutChecker
    ports/         SessionRepository / MessageGateway / ParticipantAgent
    factories/     依存配線
  domain/
    entities/      Session / DebateRound / AgentMemory<Side> / Judgment
    value-objects/ CourtLevel / SessionPhase / OpponentPublicView
    policies/      SessionPolicy / IsolationPolicy / BriefGapPolicy
  infrastructure/
    agents/        AAgent / BAgent / JudgeAgent (実装を共有しない)
    llm/           PromptDrivenLlmGateway / PromptCatalog (A/B プロンプト分離)
    persistence/   InMemory / Encrypted セッションリポジトリ
```

### A/B 分離の方針

「A 側のロジックが B 側の本音を見ない」を 3 層で保証:

| 層 | 仕組み |
|---|---|
| 型 | `OwnBrief<Side>` ブランド型で brief 文字列に side タグを付与 |
| ドメイン | `Session.agentMemoryA` / `agentMemoryB` を別インスタンスで保持 |
| ランタイム | `IsolationPolicy.assertOwnBriefAccess` を Agent メソッド冒頭で実行 |

### 主な入口

- 起動: `src/index.ts`
- Discord 受信: `src/bot/client.ts`
- 対話進行: `src/application/coordinators/DebateCoordinator.ts`
- 代理人: `src/infrastructure/agents/AAgent.ts` / `BAgent.ts`
- 判定: `src/infrastructure/agents/JudgeAgent.ts`

---

## ライセンス

MIT
