# ゴルフレッスン予約

毎月23日22時の予約開放に合わせ、指定条件に合う日付を自動で予約するための検討・実装用リポジトリ。

## ドキュメント

- [要件定義](docs/requirements.md) … 要件の一覧と詳細
- [手順メモ](docs/手順メモ.md) … ログイン〜予約確定までの操作手順
- [アーカイブ・参考用](docs/old/) … 実現可能性の検証・自動化前チェックリスト・予約詳細HTMLサンプル
- [予約フロー](docs/flow.md) … 1件目・2件目、土日祝優先の動作
- [GitHub Actions セットアップ](docs/github-actions-setup.md) … 23日22時実行・Slack 通知の設定
- [Googleカレンダー候補日 → Slack](docs/google-calendar-slack-setup.md) … 候補日投稿の設定
- [Slack 通知の設定（SLACK_WEBHOOK_URL）](docs/slack-setup.md) … Webhook の取得と登録方法
- [予約可能日時の指定](docs/予約可能日時の指定.md) … その月の予約開放日時の指定方法
- [次にやること](docs/next-steps.md) … 動作確認・Slack・GHA・運用のチェックリスト

## 要件サマリ

- 毎月23日22時から翌月分の予約が可能（月によって変動あり → 開始日時も入力可）
- 月2枠まで予約可能
- 予約サイト: [ePark マイページ 予約カレンダー](https://appy-epark.com/users/mypage/reservation/calendar.php)
- 手順: ログイン → 空枠確認・予約する → 各種50分枠レッスン → 〇の枠を選択 → ペアレッスンにチェック → 予約する
- 条件: 可能な日付・時間帯（例: 17時〜18時）を設定ファイル or スプレッドシートで入力。毎月 Slack リマインダー後に入力
- 可能なら中1週は空ける（月初・月末週を優先）
- 実行は GAS または GitHub Actions を想定。起動時に Slack で通知
- **キャンセル待ち**: 2枠取れない場合、条件に合う〇をキャンセル待ちとして登録（最大10件）。登録日時は `waitlist.json` に保存
- **キャンセル監視**: `npm run watch` または GHA で 30分ごとに実行。waitlist 以外で条件に合う〇が出たら即予約して Slack 通知

## 予約自動化ツール（プロトタイプ）

Playwright によるブラウザ自動化スクリプトを用意しています。

- **場所**: `scripts/reserve.js`
- **設定**: `config.yaml`（条件・対象月・時間帯・予約開始日時）、`.env`（メール・パスワード）
- **使い方**: [scripts/README.md](scripts/README.md) を参照

```bash
npm install
npx playwright install chromium
cp config.example.yaml config.yaml
cp .env.example .env
# config.yaml と .env を編集後
npm run reserve          # ヘッドレス
npm run reserve:headed   # ブラウザ表示（デバッグ用）
npm run watch            # キャンセル監視（条件に合う枠があれば即予約）
npm run watch:headed     # キャンセル監視（ブラウザ表示）
```

- **スケジュール実行**: [.github/workflows/reserve.yml](.github/workflows/reserve.yml) で毎月23日22時（JST）に自動実行。対象月は翌月に自動設定。詳細は [GitHub Actions セットアップ](docs/github-actions-setup.md)。
- **Slack 通知**: `.env` に `SLACK_WEBHOOK_URL` を設定するか、GitHub の Secrets に `SLACK_WEBHOOK_URL` を設定すると、スクリプト起動時・キャンセル枠予約時に Slack へ通知されます。登録方法は [Slack 通知の設定](docs/slack-setup.md)。
- **予約可能日時**: その月の予約開放日時は `config.yaml` の `reservationOpensAt` または環境変数 `RESERVATION_OPENS_AT` で指定。詳細は [予約可能日時の指定](docs/予約可能日時の指定.md)。
- **キャンセル監視**: [.github/workflows/watch-cancellation.yml](.github/workflows/watch-cancellation.yml) で 30分ごとに実行。予約ジョブで作成した `waitlist.json` をキャッシュで共有して使用。  
