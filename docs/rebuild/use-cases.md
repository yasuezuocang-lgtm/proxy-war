# proxy-war ユースケース整理

## 1. 方針

- この文書は「今の実装に存在するユースケース」を整理する
- 理想設計上の粒度ではなく、現在の責務分割を正本として扱う
- `UseCase` クラス化済みのものと、`DebateOrchestrator` にまとまっているものを分けて記載する

## 2. 全体像

現在の主要ユースケースは 8 個ある。

1. セッションを開始する
2. 依頼人の本音を受け取り、要約確認へ進める
3. 要約確認を確定または修正する
4. ゴールを設定して準備完了にする
5. 参加者メッセージを現在状態に応じて振り分ける
6. 代理対話を開始してターン進行する
7. ヒアリングで追加情報を取り込む
8. 判定を返してセッションを終了する

## 3. ユースケース一覧

### UC-01 セッションを開始する

- 主体: 依頼人
- きっかけ: Bot へ最初の DM を送る
- 結果: セッション作成、参加者状態を `inputting` に遷移
- 実装:
  - [StartSessionUseCase.ts](/Users/taguchi/Desktop/proxy-war/src/application/usecases/StartSessionUseCase.ts:1)
  - [SessionStateMachine.ts](/Users/taguchi/Desktop/proxy-war/src/application/services/SessionStateMachine.ts:1)

### UC-02 本音を受け取り、要約確認へ進める

- 主体: 依頼人
- きっかけ: 入力中の DM
- 結果:
  - 入力が短すぎれば追加入力を促す
  - 情報が足りなければ追加質問を返す
  - 十分ならブリーフを生成し、`confirming` へ遷移
- 実装:
  - [SubmitInputUseCase.ts](/Users/taguchi/Desktop/proxy-war/src/application/usecases/SubmitInputUseCase.ts:1)
  - [BriefComposer.ts](/Users/taguchi/Desktop/proxy-war/src/application/services/BriefComposer.ts:1)

### UC-03 要約確認を確定または修正する

- 主体: 依頼人
- きっかけ: 確認フェーズ中の DM
- 結果:
  - `はい` の場合は `goal_setting` へ遷移
  - 修正の場合は既存ブリーフを更新し、確認文を再生成
  - 会話ログや AI 返答だけの入力は修正文として採用しない
- 実装:
  - [ConfirmBriefUseCase.ts](/Users/taguchi/Desktop/proxy-war/src/application/usecases/ConfirmBriefUseCase.ts:1)
  - [BriefComposer.ts](/Users/taguchi/Desktop/proxy-war/src/application/services/BriefComposer.ts:1)

### UC-04 ゴールを設定して準備完了にする

- 主体: 依頼人
- きっかけ: ゴール設定フェーズ中の DM
- 結果:
  - `ゴール:...` を保存
  - `なし` でも準備完了にできる
  - 両者が揃うとセッションを `ready` にする
- 実装:
  - [SetGoalUseCase.ts](/Users/taguchi/Desktop/proxy-war/src/application/usecases/SetGoalUseCase.ts:1)
  - [SessionStateMachine.ts](/Users/taguchi/Desktop/proxy-war/src/application/services/SessionStateMachine.ts:1)

### UC-05 参加者メッセージを現在状態に応じて振り分ける

- 主体: Discord 受信口
- きっかけ: DM を受信する
- 結果:
  - `inputting` なら `SubmitInputUseCase`
  - `confirming` なら `ConfirmBriefUseCase`
  - `goal_setting` なら `SetGoalUseCase`
  - `ready` 以降は待機メッセージを返す
- 実装:
  - [HandleParticipantMessageUseCase.ts](/Users/taguchi/Desktop/proxy-war/src/application/usecases/HandleParticipantMessageUseCase.ts:1)
  - [DiscordInputCoordinator.ts](/Users/taguchi/Desktop/proxy-war/src/presentation/discord/DiscordInputCoordinator.ts:1)

### UC-06 代理対話を開始してターン進行する

- 主体: システム
- きっかけ: 両者の準備完了
- 結果:
  - `district` ラウンドを開始
  - `#talk` に開始メッセージを出す
  - ターンごとに LLM へ代理発言を生成させる
- 実装:
  - [DebateOrchestrator.ts](/Users/taguchi/Desktop/proxy-war/src/application/services/DebateOrchestrator.ts:1)
  - [client.ts](/Users/taguchi/Desktop/proxy-war/src/bot/client.ts:1)

### UC-07 ヒアリングで追加情報を取り込む

- 主体: 代理 Bot
- きっかけ: 代理発言が `[HEARING:質問]` を返す
- 結果:
  - 依頼人へ DM で確認
  - 回答が来たらブリーフ更新
  - タイムアウトなら既存情報で対話再開
- 実装:
  - [DebateOrchestrator.ts](/Users/taguchi/Desktop/proxy-war/src/application/services/DebateOrchestrator.ts:1)
  - [PendingParticipantResponseRegistry.ts](/Users/taguchi/Desktop/proxy-war/src/presentation/discord/PendingParticipantResponseRegistry.ts:1)

### UC-08 判定を返してセッションを終了する

- 主体: システム
- きっかけ: 最大ターン到達
- 結果:
  - 対話を `judging` に遷移
  - 審判 AI で判定
  - スコア、総評、落とし所、知見を投稿
  - 現在実装では即時終了する
- 実装:
  - [DebateOrchestrator.ts](/Users/taguchi/Desktop/proxy-war/src/application/services/DebateOrchestrator.ts:1)
  - [PromptDrivenLlmGateway.ts](/Users/taguchi/Desktop/proxy-war/src/infrastructure/llm/PromptDrivenLlmGateway.ts:1)

## 4. 現在の責務分割

### 4.1 `UseCase` クラス化済み

- `StartSessionUseCase`
- `SubmitInputUseCase`
- `ConfirmBriefUseCase`
- `SetGoalUseCase`
- `HandleParticipantMessageUseCase`

### 4.2 オーケストレータにまとまっているもの

- 対話開始
- ターン進行
- ヒアリング要求
- ヒアリング回答反映
- 判定
- 終了通知

`DebateOrchestrator` は今のところ「対話フェーズ全体のアプリケーションサービス」として機能している。

## 5. 今後の分割候補

現在の実装で次に分ける価値が高いのは以下。

1. `StartDebateUseCase`
2. `ProcessDebateTurnUseCase`
3. `SubmitHearingAnswerUseCase`
4. `JudgeRoundUseCase`
5. `ResetSessionUseCase`

分ける理由:

- テスト単位を小さくできる
- タイムアウトや例外系を個別に扱いやすい
- `DebateOrchestrator` の責務を「流れの調停」に絞れる

## 6. 画面というより対話フローで見た整理

1. 依頼人が本音を送る
2. Bot が要約して確認する
3. 依頼人が修正または確定する
4. 必要ならゴールを設定する
5. 両者が揃ったら代理対話を始める
6. 足りない情報があればヒアリングする
7. 判定を返す
8. リセットで次の案件へ進む

## 7. 現状の注意点

- 要件上は上告を扱う設計だが、現行ランタイムでは上告フローは未実装
- 要件上は永続化を想定しているが、現行ランタイムのセッション保存は `InMemorySessionRepository`
- つまり「入力から判定までの主経路」は新アーキテクチャ化済みだが、周辺ユースケースはまだ伸びしろがある
