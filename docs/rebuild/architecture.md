# proxy-war アーキテクチャ

## 1. 設計方針

- **完全分離原則を構造で強制**する（ドキュメントや規律ではなく型と依存関係で守る）
- レイヤード構成を採用、依存方向は単一
- Discord SDK と LLM SDK は外側へ閉じ込め、コアロジックから独立
- セッション進行は状態機械で管理、条件分岐の散在を許さない

## 2. レイヤー構成

```
presentation        ← Discord / CLI 入出力
    │
    ▼
application         ← UseCase / Coordinator / StateMachine / Agent 抽象
    │
    ▼
domain              ← Session / AgentMemory / Round / Judgment / Policy
    ▲
    │
infrastructure      ← LLM / Discord / Persistence 実装（domain と application の抽象を実装）
```

依存ルール：

- `domain` は他のどの層も import しない
- `application` は `domain` のみを import する
- `presentation` と `infrastructure` は `application` `domain` を import してよい
- `presentation` と `infrastructure` は相互に import しない（共通要素は `application` 側ポートを通る）

## 3. ディレクトリ構成

```text
src/
  presentation/
    discord/
      DiscordBotRunner.ts
      DiscordEventRouter.ts
      DiscordMessageHandler.ts
      ParticipantPort.ts          # 依頼人 → AgentMemory ルート
    cli/
      SetupCommand.ts
      SetupChannelsCommand.ts

  application/
    usecases/
      StartSessionUseCase.ts
      SubmitInputUseCase.ts
      ConfirmBriefUseCase.ts
      SetGoalUseCase.ts
      StartDebateUseCase.ts
      ProcessAgentTurnUseCase.ts
      SubmitHearingAnswerUseCase.ts
      JudgeRoundUseCase.ts
      AppealJudgmentUseCase.ts
      ResetSessionUseCase.ts
    coordinators/
      DebateCoordinator.ts        # 司会のみ（旧 DebateOrchestrator の縮小版）
    services/
      SessionStateMachine.ts
      BriefComposer.ts
      HearingDispatcher.ts
    agents/
      ParticipantAgent.ts         # 抽象
      JudgeAgent.ts               # 抽象
    ports/
      LlmGateway.ts               # ユースケース別の細粒度 API
      MessageGateway.ts
      SessionRepository.ts

  domain/
    entities/
      Session.ts
      AgentMemory.ts              # A/B 別インスタンスを Session が保持
      Brief.ts
      DebateRound.ts
      DebateTurn.ts
      HearingExchange.ts
      Judgment.ts
    value-objects/
      Side.ts                     # "A" | "B" の brand 型
      SessionPhase.ts
      ParticipantPhase.ts
      CourtLevel.ts
      PublicMessage.ts
      OpponentPublicView.ts       # 相手側に渡せる情報の型
    policies/
      SessionPolicy.ts
      IsolationPolicy.ts          # 情報リーク防止規約
    errors/
      DomainError.ts

  infrastructure/
    discord/
      DiscordClientFactory.ts
      DiscordMessageGateway.ts
    llm/
      PromptCatalog.ts            # A 用 / B 用に独立したエントリ
      LlmParticipantAgent.ts      # ParticipantAgent の LLM 実装
      LlmJudgeAgent.ts            # JudgeAgent の LLM 実装
      providers/
        AnthropicClient.ts
        OpenAIClient.ts
        GeminiClient.ts
    persistence/
      EncryptedSessionRepository.ts

  shared/
    result/
    logging/
    clock/
```

## 4. 集約設計

### 4.1 Session ルート

```ts
class Session {
  readonly id: SessionId;
  readonly guildId: GuildId;
  readonly phase: SessionPhase;
  readonly memoryA: AgentMemory;     // 相互参照不可
  readonly memoryB: AgentMemory;
  readonly rounds: DebateRound[];
  readonly currentRoundIndex: number;
  readonly appeals: AppealRecord[];
}
```

設計ポイント：

- `memoryA` と `memoryB` は別インスタンス、共有フィールドなし
- 集約を取り出すユースケースは存在するが、片側エージェントへ渡す前に**自側 memory のみ**を抽出して渡す
- `Session` を `AgentA` の引数に取る関数は禁止

### 4.2 AgentMemory（side 別）

```ts
class AgentMemory {
  readonly side: Side;             // brand 型で混同防止
  readonly principalId: UserId;
  readonly privateBrief: Brief;
  readonly privateGoal: string | null;
  readonly publicGoal: string | null;
  readonly strategyNotes: StrategyNote[];
  readonly hearingHistory: HearingExchange[];
}
```

- `AgentMemory<A>` と `AgentMemory<B>` を型レベルで区別したい場合は `Side` を phantom type として持つ
- `AgentA` のメソッドシグネチャで `AgentMemory<A>` のみ受け取るよう型制約をかける（実装は段階的に）

### 4.3 DebateRound

```ts
class DebateRound {
  readonly courtLevel: CourtLevel;
  readonly turns: DebateTurn[];      // 公開ログ
  readonly hearings: HearingExchange[];  // メタ情報のみ、本文は AgentMemory 側
  readonly judgment: Judgment | null;
}
```

ヒアリング **回答本文** は `AgentMemory` に格納し、`DebateRound` には誰がいつ何を尋ねたかのメタ情報のみ残す。

## 5. ポート（抽象インターフェース）

### 5.1 LlmGateway（細粒度 API）

```ts
export interface LlmGateway {
  extractBrief(input: ExtractBriefInput): Promise<StructuredBrief>;
  refineBrief(input: RefineBriefInput): Promise<StructuredBrief>;
  generateBriefConfirmation(input: ConfirmationInput): Promise<string>;
  generateAgentTurn(input: GenerateAgentTurnInput): Promise<AgentTurnRaw>;
  generateConsolation(input: ConsolationInput): Promise<string>;
  judgeRound(input: JudgeRoundInput): Promise<Judgment>;
}
```

`generateAgentTurn` の `input` に **`side` を持たない**。代わりに side 専用プロンプト ID を渡す：

```ts
interface GenerateAgentTurnInput {
  promptId: "DEBATE_TURN_PROMPT_A" | "DEBATE_TURN_PROMPT_B";
  privateBrief: string;
  privateGoal: string | null;
  opponentPublicView: OpponentPublicView;
  publicTranscript: PublicMessage[];
  hearingHistory: HearingExchange[];
}
```

これにより：

- A の発言生成と B の発言生成は **別の promptId** で識別される
- LLM ゲートウェイ実装内部で誤って共有プロンプトを使っても、ID で異常検知できる
- A/B で異なるモデル・温度を使う将来拡張も `promptId → 設定` のマッピングで実現可能

### 5.2 MessageGateway

```ts
export interface MessageGateway {
  sendDmToA(message: string): Promise<void>;
  sendDmToB(message: string): Promise<void>;
  sendTalk(message: PublicMessage): Promise<void>;
  sendTypingA(): Promise<void>;
  sendTypingB(): Promise<void>;
}
```

`sendDm(side, message)` のような共通 API は禁止。間違って B 宛に A の DM を送るリスクを型で潰す。

### 5.3 SessionRepository

```ts
export interface SessionRepository {
  findActiveByGuildId(guildId: GuildId): Promise<Session | null>;
  findById(sessionId: SessionId): Promise<Session | null>;
  save(session: Session): Promise<void>;
  archive(sessionId: SessionId): Promise<void>;
}
```

実装は `EncryptedSessionRepository`（永続化）と `InMemorySessionRepository`（テスト用）。

## 6. アプリケーションサービス

### 6.1 DebateCoordinator

責務（agents.md §5 と同一）：

1. ラウンド開始イベント発火
2. 話者順に対象 `ParticipantAgent` の `generate*Turn` を呼ぶ
3. 戻り値に応じて公開ログ追加 or ヒアリング遷移
4. ターン上限到達でラウンド終了→ `JudgeAgent` 呼び出し

実装制約：

- LLM を直接呼ばない（`ParticipantAgent` 経由のみ）
- 自身は `AgentMemory` を持たない（参照のみ）
- `Session` 集約を保持するが、`AgentA` `AgentB` インスタンスを参照する側

### 6.2 SessionStateMachine

```ts
type SessionEvent =
  | { type: "StartSession"; ... }
  | { type: "BothParticipantsReady" }
  | { type: "StartDebate" }
  | { type: "RequestHearing"; side: Side; question: string }
  | { type: "ResolveHearing"; side: Side }
  | { type: "FinishRound" }
  | { type: "JudgedAndAppealable"; loser: Side }
  | { type: "JudgedFinal" }
  | { type: "AppealAccepted" }
  | { type: "AppealExpired" }
  | { type: "ResetSession" }
  | ...;

class SessionStateMachine {
  transition(session: Session, event: SessionEvent): Session;
  canTransition(session: Session, eventType: SessionEvent["type"]): boolean;
}
```

- 全遷移は表で定義（`state-machine.md`）
- 不正遷移は `DomainError.IllegalTransition` を投げる
- ユースケースは状態機械許可済みの操作のみ実行

### 6.3 BriefComposer

責務：

- 依頼人入力の構造化（`extractBrief` / `refineBrief` 呼び出し）
- 確認文生成
- 追加発言による更新

側引数を持つが、内部で対応 `AgentMemory` のみを更新する。両 `AgentMemory` を同時に触る API は提供しない。

### 6.4 HearingDispatcher

責務：

- `ParticipantAgent` から `hearing` 戻り値を受け取り、`MessageGateway` 経由で対応側依頼人へDM
- タイムアウト管理
- 回答受信時に対応 `ParticipantAgent.absorbHearingAnswer` を呼ぶ

A 向けと B 向けの DM ルートは型レベルで分離（`MessageGateway` の `sendDmToA` / `sendDmToB`）。

## 7. プロンプト管理

`PromptCatalog` は仕様書として扱う。

- 各エントリは ID・入力型・期待出力型・本文を持つ
- `BRIEF_EXTRACT_PROMPT_A` `BRIEF_EXTRACT_PROMPT_B` のように side 別エントリ
- 共通本文でも別エントリで登録（差し替え時の影響範囲を限定）
- 将来 JSON Schema を組み合わせて出力構造を厳密化

```ts
interface PromptEntry<I, O> {
  readonly id: PromptId;
  readonly inputType: TypeBrand<I>;
  readonly outputType: TypeBrand<O>;
  readonly template: (input: I) => string;
}
```

## 8. エラー処理

| 層 | 例外型 | 役割 |
| --- | --- | --- |
| domain | `DomainError` | 業務ルール違反、不正遷移 |
| application | `ApplicationError` | ユースケース失敗、LLM Gateway エラーラップ |
| infrastructure | `InfrastructureError` | 外部 SDK エラー |
| presentation | （表示用文字列） | DomainError / ApplicationError を依頼人向け文言に変換 |

ドメイン層が表示用文字列を返さない、というルールを徹底する。

## 9. 状態管理の集中化

現状コード（`DebateOrchestrator`）にある「状態を見て if 分岐する」コードを禁じる。状態判定はすべて `SessionStateMachine` 経由：

```ts
// 禁止
if (session.phase === "debating" && hasHearing) { ... }

// 推奨
if (stateMachine.canTransition(session, "RequestHearing")) { ... }
```

## 10. テスト戦略

### 10.1 Domain

- `SessionStateMachine` の全遷移を表テストで網羅
- `IsolationPolicy` 違反検出テスト（型 + 実行時アサートの両輪）
- `Session` の不変条件（A/B memory 相互参照禁止など）

### 10.2 Application

- 各 UseCase をモック Gateway / モック Agent でテスト
- `DebateCoordinator` を `FakeAgent` 2体でテスト
- `BriefComposer` を A/B 別々に呼んでも漏洩しないこと

### 10.3 Agents

- `LlmParticipantAgent` をモック LLM Gateway でテスト
- A 用インスタンスに B のブリーフを渡す型エラー（コンパイル時テスト）
- `ParticipantAgent` 抽象に対する契約テスト（contract test）

### 10.4 Infrastructure

- `LlmGateway` 各実装の入出力変換
- `EncryptedSessionRepository` の暗号化往復
- `DiscordMessageGateway` 接続確認

## 11. 現行実装との差分（要約）

| 項目 | 現行 | 新設計 |
| --- | --- | --- |
| 代理発言の主体 | 単一 `PromptDrivenLlmGateway` | A/B 別 `LlmParticipantAgent` インスタンス |
| 司会 | `DebateOrchestrator` が司会 + 発言生成 + 判定起動 | `DebateCoordinator` は司会のみ |
| 判定 | `LlmGateway.judgeRound` | 独立 `JudgeAgent` 実装 |
| AgentMemory | `Session` 内に2側分のフィールド散在 | `AgentMemory` エンティティを A/B 独立保持 |
| プロンプト | 共通プロンプト + side 引数 | A 用 / B 用に分離した別エントリ |
| 情報分離 | 慣習・規律ベース | 型 + IsolationPolicy で構造的に強制 |

## 12. 設計原則（再掲）

- **完全分離は型と依存方向で守る**。レビュー規律に依存させない
- 外部都合（Discord・LLM SDK）でコア構造を曲げない
- 状態は単一の状態機械で集中管理する
- A/B どちらの作業か常に型レベルで識別可能にする
