# 次にやること

ここまでで「予約」「キャンセル待ち」「キャンセル監視」のスクリプトと GitHub Actions のワークフローまで用意済みです。次は以下を順に進めるとよいです。

---

## 0. 条件の指定（config.yaml）

スクリプトは **config.yaml** の次の項目を「条件」として使います。**ここを編集しないと希望日・時間帯で絞れません。**

- **preferredDays**: 予約したい日（月の日付）のリスト。例: `[1,2,3,7,8,25,26,27,28]` ＝ 1,2,3,7,8 日と 25〜28 日だけ。**空 `[]` なら「どの日でも可」。**
- **timeRange.start / end**: 予約したい時間帯（時）。例: `start: 17, end: 18` ＝ 17時〜18時の枠だけ。  
〇をクリックしたあと、予約詳細ページの日付・時刻を読んで、この条件に合うときだけ予約します。

---

## 1. ローカルで動作確認（最優先）

- **予約フロー**: `npm run reserve:headed` でブラウザを表示し、ログイン → 空枠確認・予約する → 各種50分枠 → カレンダー → 〇クリック → ペアレッスン → 予約する まで問題ないか確認する。
- **キャンセル待ち**: 実際のサイトで「予約詳細」画面に「キャンセル待ち」ボタン／リンクがあるか確認する。文言や位置が違う場合は [scripts/reserve.js](../scripts/reserve.js) の「キャンセル待ち」用セレクタ（`/キャンセル待ち|待ち/` など）を調整する。
- **キャンセル監視**: 1回 `npm run reserve` を実行して `waitlist.json` ができるか確認したあと、`npm run watch:headed` でキャンセル監視の流れ（ログイン → カレンダー → 〇のうち waitlist 以外で条件に合う枠を探す）が動くか確認する。

---

## 2. Slack 通知を有効にする（任意）

- [Slack 通知の設定](slack-setup.md) の手順で Incoming Webhook を作成し、**Webhook URL** を取得する。
- **ローカル**: `.env` に `SLACK_WEBHOOK_URL=https://hooks.slack.com/...` を追加する。
- **GitHub Actions**: リポジトリの **Settings → Secrets and variables → Actions** で `SLACK_WEBHOOK_URL` を追加する。

---

## 3. GitHub Actions で動かす場合

- **Secrets の設定**: 同じく **Settings → Secrets and variables → Actions** で `GOLF_RESERVATION_EMAIL` と `GOLF_RESERVATION_PASSWORD` を登録する。
- **ワークフローの場所**: このプロジェクトが **dev-workspace などモノレポのサブフォルダ** にある場合、GitHub は **リポジトリルートの .github/workflows/** だけを実行します。  
  → ルートの `.github/workflows/` に `reserve.yml` と `watch-cancellation.yml` をコピーし、中身の `working-directory` や `path` を **このプロジェクトのパス**（例: `personal/projects/golf-lesson-reservation`）に合わせる。  
  リポジトリ直下が golf-lesson-reservation の場合は `working-directory: .`、`path: waitlist.json` などに変更する。
- **初回確認**: Actions タブで「ゴルフレッスン予約」を選び、「Run workflow」で手動実行し、ログでエラーが出ないか確認する。

---

## 4. 運用まわり

- **予約可能日時が月によって違う場合**: [予約可能日時の指定](予約可能日時の指定.md) のとおり、`config.yaml` の `reservationOpensAt` や環境変数 `RESERVATION_OPENS_AT` でその月の開放日時を指定する。
- **パスワード**: 以前チャットでパスワードを共有している場合は、作業が落ち着いたら **パスワードの変更** を検討する。
- **毎月の条件**: 希望日・時間帯は `config.yaml`（または `config.example.yaml` を編集してコミット）で管理。Slack などでリマインダーを送り、そのタイミングで `config.yaml` を更新する運用でもよい。

---

## まとめ（優先度）

| 順番 | やること |
|------|----------|
| 1 | ローカルで `npm run reserve:headed` を実行し、予約フローとキャンセル待ちの画面を確認。必要ならセレクタを修正 |
| 2 | Slack Webhook を作成し、`.env` または GitHub Secrets に `SLACK_WEBHOOK_URL` を登録 |
| 3 | GitHub で Secrets（`GOLF_RESERVATION_EMAIL`, `GOLF_RESERVATION_PASSWORD`）を設定し、ワークフローをルートの `.github/workflows/` に置いて手動実行で確認 |
| 4 | 予約可能日時や毎月の条件を `config.yaml` で調整し、必要ならパスワード変更 |

ここまでできていれば、23日22時の自動予約と 30分ごとのキャンセル監視を運用できます。
