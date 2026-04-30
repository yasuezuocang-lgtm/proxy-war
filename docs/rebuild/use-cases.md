# proxy-war ユースケース定義

## 1. 方針

新仕様におけるユースケースを **責務担当（どのコンポーネントが何をするか）** で再定義する。`agents.md` の完全分離原則を破らない範囲で粒度を切る。

## 2. 一覧

| ID | 名称 | 起動主体 | 主担当 |
| --- | --- | --- | --- |
| UC-01 | セッションを開始する | 依頼人（DM） | `StartSessionUseCase` |
| UC-02 | 本音入力を取り込む | 依頼人（DM） | `SubmitInputUseCase` + 対応側 `BriefComposer` |
| UC-03 | ブリーフを確定する | 依頼人（DM） | `ConfirmBriefUseCase` |
| UC-04 | ゴールを設定する | 依頼人（DM） | `SetGoalUseCase` |
| UC-05 | 代理対話を開始する | システム | `StartDebateUseCase` |
| UC-06 | 代理ターンを処理する | 司会 | `ProcessAgentTurnUseCase` + 対応側 `ParticipantAgent` |
| UC-07 | ヒアリング回答を取り込む | 依頼人（DM） | `SubmitHearingAnswerUseCase` + 対応側 `ParticipantAgent` |
| UC-08 | 判定する | 司会 | `JudgeRoundUseCase` + `JudgeAgent` |
| UC-09 | 上告を受け付ける | 敗者（DM） | `AppealJudgmentUseCase` |
| UC-10 | セッションをリセットする | 依頼人（DM） | `ResetSessionUseCase` |
| UC-11 | 対応側に DM を仕分ける | システム | `HandleParticipantMessageUseCase` |

## 3. 各ユースケース詳細

### UC-01 セッションを開始する

- 前提：当該ギルドにアクティブセッションが無い
- 入力：依頼人 ID、所属側（A or B）、初回 DM
- 処理：
  1. `Session` 集約を作成
  2. `AgentMemory<A>` / `AgentMemory<B>` を空状態で初期化
  3. `ParticipantAgents.A` / `.B` インスタンスを生成し `Session` に紐づけ
  4. 状態を `preparing` に遷移、起動側依頼人を `inputting` に
- 結果：相手参加待ち
- 不変条件：A 側依頼人 ID は `AgentMemory<A>` のみと紐づく

### UC-02 本音入力を取り込む

- 前提：依頼人状態が `inputting`
- 主担当：`SubmitInputUseCase`
- 副担当：対応側 `ParticipantAgent` 内の brief 取り込み
- 処理：
  1. 短時間連投を1入力として束ねる
  2. 対応側 `ParticipantAgent` に入力を渡す
  3. 内部で `LlmGateway.extractBrief` または `appendBrief` を呼ぶ
  4. 不足があれば追加質問（プローブ）を返す
  5. 十分なら `confirming` へ遷移
- 不変条件：
  - A の入力は `AgentMemory<A>` のみを更新
  - 相手側ブリーフ本文は一切参照しない

### UC-03 ブリーフを確定する

- 前提：依頼人状態が `confirming`
- 主担当：`ConfirmBriefUseCase`
- 処理：
  1. `はい` / 承認語句なら `goal_setting` へ遷移
  2. 修正文なら対応側 `AgentMemory` の `privateBrief` を更新し再要約
  3. 修正と判定する語彙の最小条件は `IsolationPolicy.isReviseInput()` で判定
- 不変条件：自側ブリーフのみ更新

### UC-04 ゴールを設定する

- 前提：依頼人状態が `goal_setting`
- 入力：`ゴール:...` または `なし` / `スキップ`
- 処理：
  1. **公開ゴール**（相手側エージェントから見える）と**私的ゴール**（自側のみ）に分離
  2. 私的ゴール未設定でも対話開始可能
  3. 状態を `ready` に
- 結果：両者 `ready` で `BothParticipantsReady` 発火→セッション状態 `ready` へ

### UC-05 代理対話を開始する

- 前提：セッション状態 `ready`
- 主担当：`StartDebateUseCase`
- 処理：
  1. 新規 `DebateRound` を作成（審級は `district` から）
  2. `DebateCoordinator` を起動
  3. `#talk` に対話開始メッセージ（システム文）を送信
  4. 状態を `debating` に
- 担当外：発言生成（`ParticipantAgent` の責務）

### UC-06 代理ターンを処理する

- 前提：セッション状態 `debating`、話者が決定済み
- 主担当：`ProcessAgentTurnUseCase`（`DebateCoordinator` から呼ばれる）
- 処理：
  1. 当該話者が A か B かに応じ、対応 `ParticipantAgent` の `generateOpeningTurn` または `generateReplyTurn` を呼ぶ
  2. 戻り値が `message` → 公開ログに追加し `MessageGateway.sendTalk` で `#talk` へ
  3. 戻り値が `hearing` → 状態を `hearing` に遷移、対応側依頼人へ DM 送信、待機
  4. 連続発言禁止ルール（業務ルール R-06）を司会で検証
- 不変条件：
  - 司会は LLM を呼ばない
  - 司会は両側の `AgentMemory` を読まない（`Session` 越しでも本文を覗かない）

### UC-07 ヒアリング回答を取り込む

- 前提：セッション状態 `hearing`、対象側が指定済み
- 主担当：`SubmitHearingAnswerUseCase`
- 処理：
  1. 対象側の `ParticipantAgent.absorbHearingAnswer` を呼ぶ
  2. 司会で `reviewHearingAnswer` を呼び、追撃質問が必要か判定
  3. 追撃必要 → 再度 DM 送信（ヒアリング上限内なら）
  4. 十分 → 状態を `debating` に戻す
- 不変条件：相手側 `ParticipantAgent` は呼ばれない

### UC-08 判定する

- 前提：セッション状態 `judging`、ラウンド対話完了
- 主担当：`JudgeRoundUseCase` + `JudgeAgent`
- 処理：
  1. 公開ログ・公開ゴール・過去判定を `JudgeAgent.judgeRound` に渡す
  2. 私的ブリーフは渡さない
  3. JSON 不正なら再試行→失敗時は引き分けにフォールバック
  4. 結果を `DebateRound.judgment` に格納
  5. 勝敗あり → 状態を `appeal_pending`、引き分け or 最終審 → `finished`
- 不変条件：判定は依頼人本音を直接読まない

### UC-09 上告を受け付ける

- 前提：セッション状態 `appeal_pending`、敗者からの DM
- 主担当：`AppealJudgmentUseCase`
- 処理：
  1. 敗者本人であることを検証
  2. 上告期限内であること
  3. 審級が最終審未満であること
  4. 新規 `DebateRound`（次審級）を作成
  5. 各 `ParticipantAgent` に `suggestAppealPoints` で異議材料を取らせ、対応依頼人へ DM 送信
  6. 状態を `debating` に
- 不変条件：勝者側からの上告 DM は無視

### UC-10 セッションをリセットする

- 前提：任意の状態
- 主担当：`ResetSessionUseCase`
- 処理：
  1. 両側 `ParticipantAgent.dispose()` を呼ぶ（自側メモリのみ破棄）
  2. `JudgeAgent` インスタンスが存在すれば破棄
  3. `Session` をアーカイブ
  4. 両依頼人へ完了通知
- 不変条件：片側リセット要求でもセッション全体が終了する

### UC-11 対応側に DM を仕分ける

- 前提：Discord DM 受信
- 主担当：`HandleParticipantMessageUseCase`
- 処理：
  1. DM 送信元 Bot（A or B）と依頼人 ID で対応 `Side` を特定
  2. 当該依頼人の現在状態を取得
  3. 状態に応じて UC-02 / UC-03 / UC-04 / UC-07 / UC-09 / UC-10 のいずれかへルーティング
  4. ルーティング先がない状態（`debating` 中の通常 DM など）は待機メッセージで応答
- 不変条件：A 用 Bot に届いた DM は B 側の処理に流れない

## 4. 状態と許可ユースケース

| セッション状態 | 許可される UC |
| --- | --- |
| `preparing` | UC-02 / UC-03 / UC-04 / UC-10 / UC-11 |
| `ready` | UC-05 / UC-10 |
| `debating` | UC-06 / UC-10 |
| `hearing` | UC-07 / UC-10 |
| `judging` | UC-08 / UC-10 |
| `appeal_pending` | UC-09 / UC-10 |
| `finished` | UC-10 |
| `archived` | （なし） |

ユースケースが許可状態外で呼ばれた場合、`SessionStateMachine` が `DomainError.IllegalTransition` を投げる。

## 5. 担当コンポーネントマトリクス

| UC | UseCase | Coordinator | Agent | StateMachine | Gateway |
| --- | --- | --- | --- | --- | --- |
| UC-01 | StartSession | - | (init) | startInput | Repository |
| UC-02 | SubmitInput | - | (brief intake) | - | LlmGateway / Repository |
| UC-03 | ConfirmBrief | - | (brief refine) | confirm→goalSetting | LlmGateway |
| UC-04 | SetGoal | - | - | participantReady | Repository |
| UC-05 | StartDebate | DebateCoordinator | - | startDebate | MessageGateway |
| UC-06 | ProcessAgentTurn | DebateCoordinator | A or B | - | MessageGateway |
| UC-07 | SubmitHearingAnswer | DebateCoordinator | A or B | resolveHearing | - |
| UC-08 | JudgeRound | DebateCoordinator | JudgeAgent | judged* | MessageGateway |
| UC-09 | AppealJudgment | - | A and B (suggestAppeal) | acceptAppeal | MessageGateway |
| UC-10 | ResetSession | - | A and B (dispose) | resetSession | MessageGateway / Repository |
| UC-11 | HandleParticipantMessage | (router) | - | (read) | - |

## 6. 削除予定の旧ユースケース

新仕様で消滅する／別 UC に統合されるもの。

- `LegacyParticipantAgent.generateTurn` 経由のターン処理 → UC-06 に統合
- `BriefComposer` 直呼び → UC-02 / UC-03 内部実装に閉じ込め（外部 UC として持たない）
- `DebateOrchestrator.handleAppealCycle` の単一メソッド → UC-09 に分離

詳細は `gap-analysis.md` と `migration-plan.md`。
