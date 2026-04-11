# proxy-war

Discord上で動作する代理対話Botシステム。対立する二者がAIに本音をインプットし、Bot同士が代理で議論。審判AIが客観的に判定を下す。

## コンセプト

人間関係のすれ違いにおいて、直接的な感情のぶつけ合いは無用な傷を生む。AIを「感情のバッファー」として機能させ、関係の「破壊ではなく、解体と再構築」を目指す。

## クイックスタート

### 前提条件

- Node.js 20以上
- Discordアカウントとサーバー管理権限
- LLM APIキー（Anthropic / OpenAI / Gemini / OpenRouter / Groq のいずれか）

### 1. インストール

```bash
git clone https://github.com/your-username/proxy-war.git
cd proxy-war
npm install
```

### 2. セットアップ

対話型ウィザードが設定を案内します。

```bash
npm run setup
```

設定内容:
- Discord Botトークン
- サーバー(Guild) ID
- LLMプロバイダーとAPIキー

### 3. Discord Botの作成

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成
2. Bot セクションでトークンを取得
3. **Message Content Intent** を有効化
4. OAuth2 > URL Generator で以下の権限でBotをサーバーに招待:
   - `bot` スコープ
   - Send Messages / Read Message History / Manage Channels / View Channels

### 4. チャンネル作成

```bash
npm run setup:channels
```

自動的に以下が作成されます:
- `proxy-war` カテゴリ
- `#control-a` — プレイヤーA専用（非公開）
- `#control-b` — プレイヤーB専用（非公開）
- `#talk` — Bot同士の議論チャンネル（公開）

### 5. 起動

```bash
npm run dev
```

## 対応LLMプロバイダー

| プロバイダー | デフォルトモデル |
|---|---|
| Anthropic | claude-sonnet-4-20250514 |
| OpenAI | gpt-4o |
| Gemini | gemini-2.0-flash |
| OpenRouter | anthropic/claude-sonnet-4-20250514 |
| Groq | llama-3.3-70b-versatile |

`.env` の `LLM_MODEL` で任意のモデルに変更可能。

## ライセンス

MIT
