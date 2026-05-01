# Security Policy

## サポート対象バージョン

開発初期段階のため、最新の `main` ブランチのみサポートします。

| Version | Supported |
| ------- | --------- |
| main    | ✅        |
| その他  | ❌        |

## 脆弱性の報告

**公開 Issue では報告しないでください。** 脆弱性情報を Issue に書くと、修正前に攻撃者へ知らせることになります。

代わりに以下のいずれかで連絡してください:

1. **GitHub Private Vulnerability Reporting** (推奨)
   - https://github.com/yasuezuocang-lgtm/proxy-war/security/advisories/new
   - リポジトリの Security タブから報告できます
2. リポジトリ管理者への DM

報告内容には以下を含めてください:

- 脆弱性の種類 (例: 認証バイパス、機密情報漏洩、RCE 等)
- 影響範囲 (どのコード・どの機能に影響するか)
- 再現手順
- 想定される影響度

## 対応プロセスと目安

- 受領確認: 5 営業日以内
- 初回トリアージ: 14 日以内
- 修正と公開: 重大度に応じて (Critical は最優先)

修正完了後、報告者の希望があれば advisory にクレジットを記載します。

## Scope と免責

このプロジェクトは個人開発の Discord Bot です。本番運用は想定していません。フォークして自分の Discord サーバーで動かす場合、API キー・トークンの管理はあなた自身の責任で行ってください。

`.env` ファイルは絶対にコミットしないでください。リポジトリの `.gitignore` に含まれています。

## 機密情報の取り扱い

このプロジェクトは以下の機密情報を扱います:

- Discord Bot Token (BOT_A_TOKEN / BOT_B_TOKEN)
- Anthropic / OpenAI / Google API Key
- AES-256-GCM セッション暗号化鍵 (SESSION_ENCRYPTION_KEY)

これらが GitHub の commit 履歴に混入した場合、必ず以下を実施してください:

1. 該当の Token / Key を**即座に**無効化・再発行する
2. 履歴から削除する (git filter-repo 等)
3. force push する前に共同作業者に周知する
