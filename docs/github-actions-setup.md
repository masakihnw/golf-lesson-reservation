# GitHub Actions セットアップ

**PC がオフでも** 毎月23日22時（JST）に予約スクリプトが自動実行されます。GitHub のサーバー上で動くため、自宅 PC の電源は不要です。

## 1. リポジトリにプッシュ

このプロジェクト（`golf-lesson-reservation` フォルダ）を **GitHub のリポジトリのルート** としてプッシュしてください。

- 例: リポジトリ名を `golf-lesson-reservation` にし、その中に `package.json` や `.github/` が直下にある状態
- モノレポ（親フォルダごとプッシュ）の場合は、ワークフロー内の `working-directory` とキャッシュの `path` を、プロジェクトがあるパスに合わせて変更してください。

## 2. シークレットの設定

リポジトリの **Settings → Secrets and variables → Actions** で次のシークレットを追加します。

| シークレット名 | 説明 | 必須 |
|----------------|------|------|
| `GOLF_RESERVATION_EMAIL` | ログイン用メールアドレス | ○ |
| `GOLF_RESERVATION_PASSWORD` | ログイン用パスワード | ○ |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL（起動通知・候補日投稿用） | 任意 |
| `CALENDAR_ID` | GoogleカレンダーID（候補日投稿ワークフロー用） | 候補日投稿時 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウント JSON 全文（候補日投稿用） | 候補日投稿時 |

- `SLACK_WEBHOOK_URL` を設定すると、スクリプト起動時に Slack へ「【ゴルフレッスン予約】スクリプトを実行しました。対象月: YYYY-MM」と投稿されます。
- Slack Webhook の作成方法: [Slack Incoming Webhooks](https://api.slack.com/messaging/webhooks) を参照。

## 3. 実行タイミング

- **スケジュール**: 毎月 **23日 22:00 JST**（= 23日 13:00 UTC）に自動実行されます。対象月は **翌月** に自動設定されます。
- **手動実行**: リポジトリの **Actions** タブで「ゴルフレッスン予約」ワークフローを選択し、「Run workflow」から実行できます。その際、オプションで「対象月 (YYYY-MM)」を指定できます。

## 4. 設定ファイルについて

- ワークフローでは `config.example.yaml` を `config.yaml` としてコピーして使用します。
- 対象月はスケジュール実行時は「翌月」、手動実行時は入力した値（未入力なら config の値）になります。
- 希望日・時間帯などは `config.example.yaml` を編集してリポジトリにコミットするか、手動実行のたびに必要に応じて `config.example.yaml` を更新してください。

## 5. 予約候補日を Slack に投稿（毎月15日・忘れないように）

- **予約候補日を Slack に投稿**（`.github/workflows/calendar-to-slack.yml`）を有効にすると、毎月 **15日 20:00 JST** に Googleカレンダーで空いている日を取得し、Slack に「今月の予約候補日」として投稿します。
- 23日22時の予約実行の約1週間前に Slack で候補日を確認でき、`config.example.yaml` の `preferredDays` を必要に応じて調整できます。
- 必要な Secrets: `CALENDAR_ID`、`SLACK_WEBHOOK_URL`、`GOOGLE_SERVICE_ACCOUNT_JSON`。詳細は [google-calendar-slack-setup.md](google-calendar-slack-setup.md) を参照。

## 6. キャンセル監視ワークフロー（30分ごと）

- **キャンセル監視**（`.github/workflows/watch-cancellation.yml`）を有効にすると、30分ごとに「条件に合うキャンセル枠」を探し、見つかれば1件予約して Slack 通知します。
- 予約ジョブ（23日実行）で作成した **waitlist.json** をキャッシュで共有するため、先に1回以上「ゴルフレッスン予約」を実行しておくと、キャンセル監視で waitlist に登録した日時が除外されます。
- リポジトリが **dev-workspace などモノレポ** の場合は、ワークフロー内の `working-directory` と `path` が `personal/projects/golf-lesson-reservation` を前提にしています。リポジトリ直下が golf-lesson-reservation の場合は、`working-directory: .` および `path: waitlist.json` などに変更してください。
- ワークフローは **リポジトリルートの .github/workflows/** に置きます。リポジトリのルートが golf-lesson-reservation であれば、そのまま動作します。

## 7. 注意事項

- 認証情報は必ず **Secrets** にのみ設定し、リポジトリにはコミットしないでください。
- 初回は手動で「Run workflow」を実行し、ログでエラーが出ないか確認することを推奨します。
