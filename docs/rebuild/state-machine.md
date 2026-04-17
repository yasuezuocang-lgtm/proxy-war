# proxy-war 状態遷移設計

## 1. 設計方針

- セッション全体の状態と参加者ごとの状態を分離する
- 画面や Discord イベントではなく、ユースケース単位で遷移を定義する
- 例外系も状態遷移として扱う

## 2. セッション状態

| 状態 | 説明 |
| --- | --- |
| `preparing` | 依頼人の入力収集、要約確認、ゴール設定を行う |
| `ready` | 両者準備完了。対話開始待ち |
| `debating` | 代理対話中 |
| `hearing` | ヒアリング待ち |
| `judging` | 審判 AI 判定中 |
| `appeal_pending` | 敗者の上告待ち |
| `finished` | 判決確定済み |
| `archived` | 保存済みで再開しない状態 |

## 3. 参加者状態

| 状態 | 説明 |
| --- | --- |
| `waiting` | まだ入力開始していない |
| `inputting` | 本音を入力中 |
| `confirming` | 要約確認中 |
| `goal_setting` | ゴール設定中 |
| `ready` | 対話準備完了 |

## 4. セッション遷移

### 4.1 基本遷移

| 現在状態 | イベント | 次状態 | 備考 |
| --- | --- | --- | --- |
| なし | `StartSession` | `preparing` | 片側入力開始 |
| `preparing` | `BothParticipantsReady` | `ready` | 両者の参加者状態が `ready` |
| `ready` | `StartDebate` | `debating` | ラウンド作成 |
| `debating` | `RequestHearing` | `hearing` | 対象参加者待ち |
| `hearing` | `ResolveHearing` | `debating` | 返答あり or タイムアウト |
| `debating` | `FinishRound` | `judging` | 最大ターン到達など |
| `judging` | `JudgedAndAppealable` | `appeal_pending` | 勝敗あり、上告余地あり |
| `judging` | `JudgedFinal` | `finished` | 引き分けまたは最終審 |
| `appeal_pending` | `AppealAccepted` | `debating` | 次審ラウンド開始 |
| `appeal_pending` | `AppealExpired` | `finished` | 判決確定 |
| `finished` | `ArchiveSession` | `archived` | 永続化完了 |

### 4.2 強制遷移

| 現在状態 | イベント | 次状態 | 備考 |
| --- | --- | --- | --- |
| 任意 | `ResetSession` | `archived` | 既存セッション破棄 |
| `hearing` | `HearingTimeout` | `debating` | 既存情報で再開 |
| `judging` | `JudgeFailed` | `finished` | フォールバック判定またはドロー扱い |

## 5. 参加者遷移

| 現在状態 | イベント | 次状態 | 備考 |
| --- | --- | --- | --- |
| `waiting` | `SubmitInitialInput` | `inputting` | 最初の DM |
| `inputting` | `InputStructured` | `confirming` | 要約生成済み |
| `inputting` | `NeedMoreInput` | `inputting` | 追加質問継続 |
| `confirming` | `ConfirmBrief` | `goal_setting` | ブリーフ確定 |
| `confirming` | `ReviseBrief` | `confirming` | 再要約 |
| `goal_setting` | `SetGoal` | `ready` | ゴールあり |
| `goal_setting` | `SkipGoal` | `ready` | ゴールなし |
| `ready` | `ResetParticipant` | `waiting` | セッションリセット時 |

## 6. 制約

- `debating` 中は参加者状態は全員 `ready` でなければならない
- `hearing` では対象参加者のみ DM 返答を受け付ける
- `appeal_pending` では敗者のみ上告イベントを発火できる
- `finished` 以降は通常入力を新規セッション扱いにする

## 7. エラー時の扱い

### 7.1 LLM エラー

- 入力整理失敗: 現状態維持で再試行可能メッセージを返す
- 対話生成失敗: 当該ターンのみ再試行
- 判定失敗: フォールバック判定または引き分け扱いで終了

### 7.2 Discord エラー

- DM 送信失敗: セッションは維持し、再送可能なイベントを残す
- `#talk` 送信失敗: 対話進行を止め、運用ログへ記録する

### 7.3 タイムアウト

- ヒアリング返信なし: `debating` へ戻る
- 上告返信なし: `finished` へ進む

## 8. ラウンドモデル

- 1 セッションは 1 つ以上のラウンドを持つ
- ラウンドごとに以下を持つ
- 審級
- ターン一覧
- ヒアリング一覧
- 判定結果

## 9. 実装指針

- `SessionStateMachine` で遷移条件を一元管理する
- 各ユースケースは状態機械の許可した操作のみ実行する
- Discord イベントは状態機械を直接触らず、必ずユースケースを経由する
