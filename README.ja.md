# Twitch リアルタイムチャットロガー

[Bun](https://bun.sh/) で構築された、Twitch チャットのリアルタイム保存およびアーカイブ自動化支援ツールです。

Twitch EventSub WebSocket を介して配信の開始・終了を自動検知し、チャットをリアルタイムで収集します。配信終了後には、チャットデータを Cloudflare R2 へアップロードし、Cloudflare D1 データベースへ記録を作成することで、[Twitch Archive Manager (tam)](https://github.com/hqk0/twitch-archive-manager) による全自動アーカイブ処理のトリガーとなります。

## 主な機能

- **EventSub 監視**: 配信のオンライン/オフライン/情報の更新をリアルタイムで検知。
- **リアルタイム保存**: IRC (tmi.js) 経由で全チャットを取得し、独自形式の JSON ファイルに保存。
- **アーカイブ自動連携**:
  - 配信終了後に Twitch API から VOD ID を自動取得。
  - チャット JSON を Cloudflare R2 (S3互換ストレージ) へ自動アップロード。
  - Cloudflare D1 (SQLite) へ配信情報を登録し、後続の処理へ連携。
- **マルチチャンネル通知**: [ntfy](https://ntfy.sh/) や LINE Messaging API による配信状況の通知に対応。
- **Bun 最適化**: 高速な起動と実行、モダンな JavaScript 環境での動作。

## 必要条件

- [Bun](https://bun.sh/) ランタイム。
- Twitch 開発者アプリケーション (Client ID / Secret)。
- (任意) Cloudflare アカウント (D1 / R2 利用時)。
- (任意) ntfy トピック、または LINE Bot の設定。

## インストール

```bash
git clone https://github.com/hqk0/twitch-rt-chat-logger.git
cd twitch-rt-chat-logger
bun install
```

## 設定

`.env.example` を `.env` にコピーし、必要な認証情報を記入してください。

## 使い方

ボットを起動します：

```bash
bun start
```

ボットは常駐し、配信が開始されるのを待ちます。配信が終了すると、自動的にチャットデータの整理とアーカイブ登録処理が実行されます。

## ワークフロー

1. **待機**: `stream.online` イベントを待受。
2. **記録**: ロガープロセス (`chat.js`) を起動し、IRC 経由でチャットをリアルタイム保存。
3. **終了**: `stream.offline` イベントを受信。
4. **完結**:
   - VOD が生成されるのを待機（30秒）。
   - API から VOD ID を取得。
   - チャット JSON を R2 へアップロード。
   - D1 データベースを更新。これにより `tam` の worker が処理を開始可能な状態になります。

## ライセンス

MIT
