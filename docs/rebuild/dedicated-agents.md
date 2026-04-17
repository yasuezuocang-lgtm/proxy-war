# proxy-war 専属エージェント化設計

## 1. 結論

このプロダクトの中核ユースケースは次の通り。

- A の依頼人は A 専属エージェントに本音を渡す
- B の依頼人は B 専属エージェントに本音を渡す
- A エージェントは A の利益だけを追う
- B エージェントは B の利益だけを追う
- 両者は互いの非公開情報を見てはいけない

つまり理想形は「1 人の AI が帽子をかぶり替える」のではなく、
「A 側代理人」と「B 側代理人」が別々に存在する構造である。

## 2. 今の実装で足りていない点

現状は情報分離まではできているが、実行主体の分離が不十分。

### 2.1 できていること

- A/B のブリーフは分かれている
- 対話ターンごとに `ownContext` は自側だけを渡している
- ヒアリングも自側依頼人にだけ飛ぶ

### 2.2 足りていないこと

- `DebateOrchestrator` が 1 つで両者を交互に進行している
- `PromptDrivenLlmGateway` が 1 つで両者の代理発言を生成している
- 実質的には同じ頭脳が `A` と `B` を切り替えて喋っている

この構造だと、情報漏洩は防げても、
「A 専属の代理人が A のためだけに考え続ける」
という体験はまだ弱い。

## 3. 専属エージェント化の要件

### 3.1 情報分離

- A エージェントは A のブリーフだけを読む
- B エージェントは B のブリーフだけを読む
- 相手側のブリーフ本文は一切参照しない

### 3.2 実行分離

- A の発言生成は A 専用コンポーネントが担当する
- B の発言生成は B 専用コンポーネントが担当する
- 同じ `generateDebateTurn` を `side` 切替で使い回さない

### 3.3 記憶分離

- A エージェントは A 側の思考履歴を持つ
- B エージェントは B 側の思考履歴を持つ
- ヒアリング回答の反映も自側メモリだけに効く

### 3.4 責務分離

- オーケストレータは司会に徹する
- 発言生成・ヒアリング判断・戦略更新は各エージェントが持つ

## 4. 理想アーキテクチャ

```text
依頼人A -> AgentA
               \
                -> DebateCoordinator -> #talk
               /
依頼人B -> AgentB

JudgeAgent -> 判定
```

### 4.1 `DebateCoordinator`

責務:

- ラウンド開始
- 話者順管理
- ターン上限管理
- ヒアリング待ち管理
- 終了と判定起動

やってはいけないこと:

- A/B の代理発言内容を自分で考える
- どちら側の利益を優先するか判断する

### 4.2 `ParticipantAgent`

責務:

- 依頼人ブリーフを読む
- 自側の戦略を組み立てる
- 相手発言に応答する
- 必要ならヒアリングを要求する

インターフェース案:

```ts
export interface ParticipantAgent {
  readonly side: "A" | "B";

  generateOpeningTurn(input: {
    brief: string;
    goal: string | null;
  }): Promise<AgentTurnResult>;

  generateReplyTurn(input: {
    brief: string;
    goal: string | null;
    opponentMessage: string;
    publicTranscript: DebateTurn[];
  }): Promise<AgentTurnResult>;

  absorbHearingAnswer(input: {
    currentBrief: string;
    answer: string;
  }): Promise<UpdatedAgentContext>;
}
```

### 4.3 `AgentTurnResult`

```ts
type AgentTurnResult =
  | { type: "message"; message: string }
  | { type: "hearing"; question: string };
```

### 4.4 `JudgeAgent`

責務:

- 対話終了後の判定だけ行う
- A/B どちらの味方にもならない

## 5. 推奨クラス分割

### 5.1 新規追加したいもの

- `ParticipantAgent` 抽象
- `AAgent` 実装
- `BAgent` 実装
- `AgentContextStore`
- `DebateCoordinator`
- `JudgeAgent`

### 5.2 既存から置き換えたいもの

- `DebateOrchestrator`
  - 今: 司会 + 代理発言生成 + ヒアリング更新 + 判定起動
  - 将来: 司会だけ

- `LlmGateway.generateDebateTurn`
  - 今: 片方の役を切り替えて呼ぶ
  - 将来: `ParticipantAgent` 内へ吸収

## 6. セッションモデルの追加項目

今の `Session` に加えて、各代理人の専属状態を持たせる。

```ts
interface AgentContext {
  side: "A" | "B";
  privateBrief: string;
  publicStrategyNotes: string[];
  hearingHistory: string[];
  turnCount: number;
}
```

ポイント:

- `privateBrief` は依頼人の非公開情報
- `publicStrategyNotes` は自分用の戦術メモ
- 相手側には絶対に見せない

## 7. ユースケース再定義

### UC-06 代理対話開始

- `StartDebateUseCase`
- AAgent / BAgent を初期化
- `DebateCoordinator` にラウンドを渡す

### UC-07 ターン進行

- `ProcessAgentTurnUseCase`
- 現在話者の専属エージェントだけを呼ぶ
- 戻り値が `message` なら投稿
- `hearing` ならヒアリングへ遷移

### UC-08 ヒアリング回答反映

- `SubmitHearingAnswerUseCase`
- 対象側エージェントだけを更新

### UC-09 判定

- `JudgeRoundUseCase`
- JudgeAgent に対話ログを渡す

## 8. 実装の第一歩

最初にやるべき変更は大きく 3 つ。

1. `LlmGateway.generateDebateTurn` をやめる
2. `ParticipantAgent` 抽象を追加する
3. `DebateOrchestrator` を `DebateCoordinator` と `ParticipantAgent` 呼び出しに分割する

## 9. 段階的移行プラン

### Phase 1

- `ParticipantAgent` 抽象追加
- 既存 `PromptDrivenLlmGateway` を内部で使う `LlmParticipantAgent` を作る
- A/B で別インスタンスを持つ

### Phase 2

- `DebateOrchestrator` から発言生成ロジックを外す
- ヒアリング更新も `ParticipantAgent` 側へ移す

### Phase 3

- `JudgeAgent` を独立
- 上告もエージェント単位で扱えるように拡張

## 10. 非機能上の効果

- A/B の責務境界が明確になる
- 片側だけのテストが書きやすくなる
- 将来、A 側と B 側でモデルやプロンプトを変えられる
- 「本当に別の代理人が戦っている」体験に近づく

## 11. 一言でいうと

今の実装は「情報分離された 1 つの頭脳」。

目指すべき実装は「情報も実行主体も分離された 2 人の代理人」。
