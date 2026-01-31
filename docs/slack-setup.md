# Slack 通知の設定（SLACK_WEBHOOK_URL）

スクリプト起動時に Slack へ「【ゴルフレッスン予約】スクリプトを実行しました。対象月: YYYY-MM」を投稿するための設定方法です。

## 1. Slack Incoming Webhook の作成

1. **Slack で Incoming Webhooks を有効にする**
   - [Slack API](https://api.slack.com/apps) にアクセス
   - 「Create New App」→「From scratch」でアプリ名とワークスペースを選択して作成
   - 左メニュー「Incoming Webhooks」を開き、**Activate Incoming Webhooks** を ON にする
   - 下部「Add New Webhook to Workspace」をクリックし、通知を投稿したいチャンネル（例: #ゴルフ予約）を選んで許可する
   - 表示された **Webhook URL**（`https://hooks.slack.com/services/xxx/xxx/xxx`）をコピーする

2. **または、チャンネルから簡単に追加する**
   - 通知したいチャンネルを開く → チャンネル名をクリック → 「連携アプリ」→「アプリを追加」
   - 「Incoming Webhooks」を検索して追加し、上記と同様に Webhook URL を取得する

## 2. どこに登録するか

### ローカルでスクリプトを実行する場合

**.env に追記**（1行で、値はダブルクォートで囲んでもよい）

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxxxx/xxxxx/xxxxx
```

- `.env` は `.gitignore` に含まれるため、Git にはコミットされません。
- 本番の Webhook URL をリポジトリにコミットしないでください。

### GitHub Actions で実行する場合

**リポジトリの Secrets に登録**

1. GitHub のリポジトリを開く
2. **Settings** → **Secrets and variables** → **Actions**
3. **New repository secret** をクリック
4. Name: `SLACK_WEBHOOK_URL`、Value: コピーした Webhook URL を貼り付けて保存

これでワークフロー実行時に、スクリプトから同じ環境変数名で参照されます。

## 3. 動作確認

- `SLACK_WEBHOOK_URL` を設定した状態で `npm run reserve` を実行すると、開始時に指定チャンネルへメッセージが投稿されます。
- 未設定の場合は通知は行われず、スクリプトはそのまま動作します。
