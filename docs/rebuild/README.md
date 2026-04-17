# proxy-war 再構築ドキュメント

## 目的

- 現行プロトタイプを仕様駆動で再構築するための入口

## 文書一覧

- `requirements.md`: 再構築後に満たすべき要件
- `state-machine.md`: セッション状態と参加者状態の遷移
- `architecture.md`: 理想アーキテクチャと責務分割
- `use-cases.md`: 現在実装に沿ったユースケース整理
- `dedicated-agents.md`: A/B 専属エージェント化の設計
- `roadmap.md`: 実装移行の順序とマイルストーン

## 読む順番

1. `requirements.md`
2. `state-machine.md`
3. `architecture.md`
4. `use-cases.md`
5. `dedicated-agents.md`
6. `roadmap.md`

## 使い方

- 要件議論では `requirements.md` を正本にする
- 実装着手前に `state-machine.md` と `architecture.md` を見直す
- 実装責務を確認したい時は `use-cases.md` を見る
- A/B 分離の設計を詰める時は `dedicated-agents.md` を見る
- タスク分解時は `roadmap.md` を基準にフェーズを切る

## 実装状況

- 入力収集、要約確認、ゴール設定は新アーキテクチャへ移行済み
- 代理対話、ヒアリング、判定も新アーキテクチャへ移行済み
- 旧 `src/core` は撤去済み
- 現在のランタイム実装は `src/presentation` / `src/application` / `src/domain` / `src/infrastructure` を使用
