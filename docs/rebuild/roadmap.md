# proxy-war 再構築ロードマップ

## 1. 方針

- 現行プロトタイプを止めずに、新設計を別系統で育てる
- まず仕様と状態遷移を固定し、その後に土台を作る
- いきなり全部載せ替えず、入力、対話、判定の順で差し替える

## 2. フェーズ計画

### Phase 0 仕様確定

目的:

- 実装前に判断基準を固定する

成果物:

- `requirements.md`
- `state-machine.md`
- `architecture.md`
- 主要ユースケース一覧

完了条件:

- セッション開始から終了までの振る舞いが文章と表で説明できる
- README とズレる仕様を意思決定できる

### Phase 1 土台構築

目的:

- 新アーキテクチャの骨格を作る

作業:

- ディレクトリ再編
- Domain エンティティ作成
- `SessionStateMachine` 実装
- `SessionRepository` 抽象作成
- `LlmGateway` 抽象作成
- `MessageGateway` 抽象作成

完了条件:

- Discord なしでコアモデルがテストできる

### Phase 2 入力フロー移行

目的:

- 最初のユーザー価値を新設計へ移す

作業:

- `StartSessionUseCase`
- `SubmitInputUseCase`
- `ConfirmBriefUseCase`
- `SetGoalUseCase`
- ブリーフ生成まわりのプロンプト移設

完了条件:

- 依頼人入力から準備完了まで新設計で動く

### Phase 3 代理対話移行

目的:

- 対話の中核を新設計へ移す

作業:

- `StartDebateUseCase`
- `ProcessDebateTurnUseCase`
- `DebateOrchestrator`
- `HearingCoordinator`
- ラウンドモデル導入

完了条件:

- ヒアリングを含む対話が新設計で進行する

### Phase 4 判定と上告移行

目的:

- セッション完結まで新設計で扱えるようにする

作業:

- `JudgeRoundUseCase`
- `AppealJudgmentUseCase`
- 判定 JSON schema 導入
- 終了時アーカイブ処理

完了条件:

- 判定、上告、確定、アーカイブまで新設計で完結する

### Phase 5 Discord Adapter 差し替え

目的:

- 新コアへ Presentation を接続する

作業:

- `DiscordEventRouter`
- `DiscordMessageHandler`
- `DiscordMessageGateway`
- 旧 `client.ts` の責務分割

完了条件:

- 実際の Discord 環境で新設計フローが動作する

### Phase 6 旧実装の縮退

目的:

- 移行コストを下げてコードを整理する

作業:

- 旧フローの feature flag 除去
- 未使用プロンプト整理
- README 更新
- 運用手順更新

完了条件:

- 旧 `bot/client.ts` 依存の進行制御を撤去できる

## 3. 優先順位

1. 状態機械
2. セッション集約
3. 入力整理ユースケース
4. ラウンド管理
5. 判定 schema 化
6. Discord adapter 分離

## 4. リスクと対策

### リスク 1 仕様が揺れたまま実装が進む

対策:

- Phase 0 を飛ばさない
- README と仕様書を同時に更新する

### リスク 2 LLM 出力の不安定さで設計が崩れる

対策:

- Gateway の戻り値を構造化する
- 判定は schema validation を通す
- フォールバック経路を先に決める

### リスク 3 Discord 事情がコアへ逆流する

対策:

- SDK 型を Application へ渡さない
- MessageGateway のみ経由させる

### リスク 4 移行途中で二重実装が長引く

対策:

- フェーズごとに置き換え対象を明示する
- 旧責務を削る完了条件を置く

## 5. 推奨実装順

1. `domain/entities/Session.ts`
2. `domain/value-objects/SessionPhase.ts`
3. `application/services/SessionStateMachine.ts`
4. `application/usecases/SubmitInputUseCase.ts`
5. `application/usecases/ConfirmBriefUseCase.ts`
6. `application/services/DebateOrchestrator.ts`
7. `application/usecases/JudgeRoundUseCase.ts`
8. `presentation/discord/DiscordMessageHandler.ts`

## 6. マイルストーン

### M1 仕様確定

- 文書レビュー完了
- 実装対象の境界確定

### M2 コア完成

- Domain と Application の主要テスト通過

### M3 Discord 接続完了

- 新設計で E2E 相当の対話が実行できる

### M4 旧実装撤去

- 旧進行制御コードの依存がなくなる

## 7. Definition of Done

- 仕様書と実装が対応づいている
- 状態遷移の単体テストがある
- 主要ユースケースのテストがある
- Discord 依存コードがコアロジックから分離されている
- README が新構成に追従している
