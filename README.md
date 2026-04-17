# proxy-war

Discord上で動作する代理対話Botシステム。対立する二者がそれぞれのAI代理Botに本音をインプットし、Bot同士が代理で議論し、審判AIが判定を返す。

## コンセプト

人間関係のすれ違いにおいて、直接的な感情のぶつけ合いは無用な傷を生む。AIを「感情のバッファー」として機能させ、関係の「破壊ではなく、解体と再構築」を目指す。

## 仕組み

```
ユーザーA ──DM──> Bot A ─┐
                          ├─> #talk (共有サーバー) で代理対話
ユーザーB ──DM──> Bot B ─┘
                              ↓
                         審判AI が判定
```

- **Bot A / Bot B**: 別々のDiscord Botアプリケーション。ユーザーはDMで本音を伝える
- **共有サーバー**: Bot同士が `#talk` チャンネルで議論する場所
- **プライバシー**: ユーザーの本音はDMで送るため、相手やサーバー管理者には見えない

## クイックスタート

### 前提条件

- Node.js 20以上
- Discordアカウント
- LLM APIキー（Anthropic / OpenAI / Gemini / OpenRouter / Groq のいずれか）

### 1. インストール

```bash
git clone https://github.com/yasuezuocang-lgtm/proxy-war.git
cd proxy-war
npm install
```

### 2. Discord Botの作成（2体）

[Discord Developer Portal](https://discord.com/developers/applications) で **2つの** アプリケーションを作成:

**Bot A（ユーザーAの代理）:**
1. 「New Application」→ 名前を付けて作成
2. Bot タブでトークンを取得
3. **Message Content Intent** を有効化
4. OAuth2 > URL Generator で招待URL生成（`bot` スコープ + Send Messages, Read Message History, View Channels）

**Bot B（ユーザーBの代理）:**
- 同じ手順で別のアプリケーションとして作成

両方のBotを **共有サーバー** に招待してください。

### 3. セットアップ

```bash
npx tsx src/setup.ts
```

対話型ウィザードが以下を案内します:
- Bot A / Bot B のトークン
- 共有サーバーのGuild ID
- LLMプロバイダーとAPIキー

### 4. チャンネル作成

```bash
npm run setup:channels
```

共有サーバーに `#talk` チャンネルが自動作成されます。

### 5. 起動

```bash
npm run dev
```

### 6. 使い方

1. ユーザーAが **Bot AにDM** で本音を送信
2. 相手側のBot Bが自動で通知
3. 両者がDMで本音を入力 → AIが要約 → 確認
4. 各自が必要ならゴールを設定
5. 両者の準備が整ったら `#talk` で代理対話が自動開始
6. 対話中に必要なら依頼人へヒアリング
7. 対話終了後、審判AIが判定
8. Botに `リセット` と送ると新しい対話を開始できる

## 現在の仕様

- 現在の実装は `喧嘩モード` 前提
- 各依頼人は任意でゴールを設定できる
- 対話中に追加確認が必要な場合はヒアリングが発生する
- 判定はスコア、総評、落とし所、知見を返す

## 対応LLMプロバイダー

| プロバイダー | デフォルトモデル |
|---|---|
| Anthropic | claude-sonnet-4-20250514 |
| OpenAI | gpt-4o |
| Gemini | gemini-2.0-flash |
| OpenRouter | anthropic/claude-sonnet-4-20250514 |
| Groq | llama-3.3-70b-versatile |

`.env` の `LLM_MODEL` で任意のモデルに変更可能。

## アーキテクチャ

現在の実装はレイヤード構成で整理されています。

- `src/presentation`: Discord連携
- `src/application`: ユースケースと対話オーケストレーション
- `src/domain`: セッション、参加者、ラウンド、判定などのドメインモデル
- `src/infrastructure`: LLM実装とリポジトリ実装

主な入口:

- 起動: `src/index.ts`
- Discord受信: `src/bot/client.ts`
- 入力フロー: `src/application/usecases/*`
- 対話進行: `src/application/services/DebateOrchestrator.ts`

## ライセンス

MIT

## 再構築ドキュメント

- `docs/rebuild/README.md`
