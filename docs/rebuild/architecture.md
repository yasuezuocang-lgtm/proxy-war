# proxy-war 理想アーキテクチャ設計

## 1. 設計目標

- Discord 依存を外側へ押し出す
- セッション進行をユースケースと状態機械で管理する
- LLM 呼び出しを抽象化し、プロンプトを仕様として扱う
- 永続化とメッセージ送信を差し替え可能にする
- 将来 Discord 以外の UI を追加できる構造にする

## 2. 採用方針

- レイヤードアーキテクチャを採用する
- 依存方向は `presentation -> application -> domain`
- `infrastructure` は `application` と `domain` の抽象を実装する
- 外部 SDK 型は `presentation` と `infrastructure` に閉じ込める

## 3. レイヤー構成

### 3.1 Presentation

責務:

- Discord のイベント受信
- DM と `#talk` への表示
- CLI セットアップ
- アプリケーション層への入力変換

主要コンポーネント:

- `DiscordBotRunner`
- `DiscordEventRouter`
- `DiscordMessageHandler`
- `SetupCommand`
- `SetupChannelsCommand`

### 3.2 Application

責務:

- ユースケースの実行
- 状態遷移管理
- トランザクション境界
- ドメインモデルの組み立て

主要コンポーネント:

- `StartSessionUseCase`
- `SubmitInputUseCase`
- `ConfirmBriefUseCase`
- `SetGoalUseCase`
- `StartDebateUseCase`
- `ProcessDebateTurnUseCase`
- `SubmitHearingAnswerUseCase`
- `JudgeRoundUseCase`
- `AppealJudgmentUseCase`
- `ResetSessionUseCase`
- `DebateOrchestrator`
- `SessionStateMachine`

### 3.3 Domain

責務:

- セッションのルール
- 値オブジェクトとエンティティ
- ラウンド、判定、ヒアリングの整合性

主要コンポーネント:

- `Session`
- `Participant`
- `Brief`
- `DebateRound`
- `DebateTurn`
- `HearingRequest`
- `Judgment`
- `SessionPolicy`
- `SessionPhase`
- `ParticipantPhase`
- `CourtLevel`

### 3.4 Infrastructure

責務:

- Discord 実装詳細
- LLM プロバイダー実装
- 暗号化保存
- ロギング

主要コンポーネント:

- `DiscordMessageGateway`
- `AnthropicLLMGateway`
- `OpenAILLMGateway`
- `GeminiLLMGateway`
- `EncryptedSessionRepository`
- `PromptCatalog`

## 4. 推奨ディレクトリ構成

```text
src/
  presentation/
    discord/
      DiscordBotRunner.ts
      DiscordEventRouter.ts
      DiscordMessageHandler.ts
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
      ProcessDebateTurnUseCase.ts
      SubmitHearingAnswerUseCase.ts
      JudgeRoundUseCase.ts
      AppealJudgmentUseCase.ts
      ResetSessionUseCase.ts
    services/
      DebateOrchestrator.ts
      BriefComposer.ts
      HearingCoordinator.ts
      SessionStateMachine.ts
  domain/
    entities/
      Session.ts
      Participant.ts
      Brief.ts
      DebateRound.ts
      DebateTurn.ts
      HearingRequest.ts
      Judgment.ts
    value-objects/
      SessionPhase.ts
      ParticipantPhase.ts
      CourtLevel.ts
    policies/
      SessionPolicy.ts
    errors/
      DomainError.ts
  infrastructure/
    discord/
      DiscordClientFactory.ts
      DiscordMessageGateway.ts
    llm/
      PromptCatalog.ts
      AnthropicLLMGateway.ts
      OpenAILLMGateway.ts
      GeminiLLMGateway.ts
    persistence/
      EncryptedSessionRepository.ts
  shared/
    result/
    logging/
    clock/
```

## 5. 主要インターフェース

### 5.1 Repository

```ts
export interface SessionRepository {
  findActiveByGuildId(guildId: string): Promise<Session | null>;
  findById(sessionId: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  archive(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
```

### 5.2 LLM Gateway

```ts
export interface LlmGateway {
  extractBrief(input: BriefInput): Promise<StructuredBrief>;
  appendBrief(input: AppendBriefInput): Promise<StructuredBrief>;
  generateProbe(input: ProbeInput): Promise<string>;
  generateConfirmation(input: ConfirmationInput): Promise<string>;
  generateDebateTurn(input: DebateTurnInput): Promise<string>;
  judgeRound(input: JudgeRoundInput): Promise<Judgment>;
  generateConsolation(input: ConsolationInput): Promise<string>;
}
```

### 5.3 Message Gateway

```ts
export interface MessageGateway {
  sendDm(side: "A" | "B", message: string): Promise<void>;
  sendTalkMessage(message: string): Promise<void>;
  sendTyping(side: "A" | "B"): Promise<void>;
}
```

## 6. 集約設計

### 6.1 `Session` を集約ルートにする

- 参加者
- ラウンド
- 現在フェーズ
- 上告情報
- タイムアウト制約

上記を `Session` が一貫して保持する

### 6.2 `DebateRound` を内包エンティティにする

- ターン一覧
- ヒアリング一覧
- 審級
- 判定結果

再審してもセッションを作り直さず、ラウンドを増やす

## 7. アプリケーションサービス設計

### 7.1 `DebateOrchestrator`

責務:

- 対話開始からラウンド終了までの流れを制御する
- ターン進行とヒアリング要求を調停する
- ラウンド終了後に判定ユースケースを起動する

### 7.2 `SessionStateMachine`

責務:

- 現状態で許可されるイベントを定義する
- 不正遷移を防ぐ
- セッション状態と参加者状態を一貫して更新する

### 7.3 `BriefComposer`

責務:

- 依頼人入力の構造化
- 確認文生成
- 追加発言による更新

## 8. プロンプト管理方針

- プロンプトは `PromptCatalog` に集約する
- 文字列定数だけでなく、入力と期待出力を型で定義する
- プロンプトを仕様書と対応づける
- 将来的には JSON schema と組み合わせて厳密化する

## 9. エラー処理方針

- ドメイン違反は `DomainError`
- 外部 API エラーは `InfrastructureError`
- ユースケース失敗は `ApplicationError`
- Discord 表示用文言はプレゼンテーション層で決める

## 10. テスト戦略

### 10.1 Domain

- 状態遷移
- 上告制約
- ヒアリング回数制限
- ラウンド追加の整合性

### 10.2 Application

- 入力追加から要約確認
- 両者準備完了から対話開始
- ヒアリングありのラウンド進行
- 判定から上告、確定まで

### 10.3 Infrastructure

- LLM Gateway のレスポンス変換
- セッション暗号化保存
- Discord Message Gateway の接続確認

## 11. 現行実装との主な差分

| 項目 | 現行 | 再構築後 |
| --- | --- | --- |
| 責務配置 | `src/bot/client.ts` に集中 | UseCase と Adapter へ分割 |
| 状態管理 | 条件分岐中心 | 状態機械中心 |
| ラウンド管理 | セッションへ直接保持 | `DebateRound` に集約 |
| Discord 依存 | コアロジックへ混在 | Presentation / Infrastructure に隔離 |
| LLM 呼び出し | 機能横断で直呼び | `LlmGateway` 経由 |
| テスト性 | 低い | 高い |

## 12. 設計原則

- 依頼人の非公開情報は境界を越えて漏らさない
- 外部都合ではなくユースケースで構造を切る
- 仕様の中心は状態遷移と業務ルールに置く
- 実装詳細ではなく責務で分割する
