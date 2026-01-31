# Googleカレンダー候補日 → Slack 投稿

予約可能な日程を「忘れないように」Slack に共有するための機能です。Googleカレンダーで**空いている日**を対象月について取得し、Slack に「今月の予約候補日」として投稿します。

## 1. 動きのイメージ

1. **対象月**（例: 翌月）の各日について、次の時間帯にカレンダーに予定が入っていない日を「候補日」とする。
   - **土日祝**: 9:00〜20:00（最終枠20:00）。1コマ1時間・移動で前後30分を確保するため、カレンダーは **8:30〜20:30** が空いている日。
   - **平日**: 18:00〜20:00（最終枠20:00）。同様に **17:30〜20:30** が空いている日。
2. 候補日一覧を **Slack** に投稿する。
3. **忘れないように**: GitHub Actions で「毎月15日」に実行すると、23日の予約実行の約1週間前に Slack で候補日を確認できる。

## 2. 必要なもの

- **Google Cloud プロジェクト**（Calendar API 有効）
- **サービスアカウント**（JSON キー）
- **Googleカレンダー**をサービスアカウントのメールに「参照」で共有
- **Slack Incoming Webhook URL**
- 環境変数: `CALENDAR_ID`, `SLACK_WEBHOOK_URL`, 認証情報（後述）

## 3. Google Cloud の設定

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセスする。
2. **プロジェクトを作成**（または既存を選択）。
   - プロジェクト名: **`golf-lesson-reservation`**（任意。既存プロジェクトでも可）
   - プロジェクトID: そのまま自動生成でよい（例: `golf-lesson-reservation-123456`）
3. **APIとサービス → ライブラリ** で「**Google Calendar API**」を検索し、**有効**にする。
4. **APIとサービス → 認証情報** で「**認証情報を作成 → サービスアカウント**」を選ぶ。
5. サービスアカウントの作成画面で、次のとおり入力する。

   | 項目 | 入力する値 |
   |------|------------|
   | サービスアカウント名 | `golf-lesson-calendar-to-slack` |
   | サービスアカウントID | 自動入力（`golf-lesson-calendar-to-slack` になる想定） |
   | 説明（任意） | `ゴルフレッスン予約候補日をSlackに投稿する用` |

   「作成して続行」をクリック。

6. **ロール**は省略して「続行」→「完了」でよい（Calendar は「カレンダーを共有」で権限を付与するため）。
7. 一覧で作成したサービスアカウント（`golf-lesson-calendar-to-slack`）をクリック → **キー** タブ → **鍵を追加** → **新しい鍵を作成** → **JSON** を選び **作成**。JSON ファイルがダウンロードされる。
8. この JSON の内容を、後述の環境変数や GitHub Secrets に設定する（ローカルでは `GOOGLE_APPLICATION_CREDENTIALS` にファイルパスを指定しても可）。

## 4. カレンダーの共有（「サービスアカウントに共有する」とは？）

**やること**: 候補日を取得したい「自分の Google カレンダー」を、スクリプトが使うサービスアカウント（＝ロボット用の Google アカウント）に「見る権限」だけ付けて共有する。こうしないとスクリプトがカレンダーを読めない。

**手順**:

1. [Google カレンダー](https://calendar.google.com/)（PC版）を開く。
2. **「設定と共有」を開く**
   - 画面**左側**の **マイカレンダー** で、候補日を取得したいカレンダー（通常は「メイン」や自分の名前のカレンダー）の**右側**にある **⋮（縦三点）** をクリック。
   - メニューから **「設定と共有」** を選ぶ。
3. **「特定のユーザーとの共有」** で次を行う。
   - **「ユーザーやグループを追加」** をクリック。
   - 次のメールアドレスを**そのまま**入力する（あなたのサービスアカウントのメール）:  
     **`golf-lesson-calendar-to-slack@ultimate-flame-425711-t2.iam.gserviceaccount.com`**
   - 権限を **「予定の表示（時間枠のみ、詳細は非表示）」** または **「予定の表示（すべての予定の詳細）」** にし、**「送信」** をクリック。
4. **カレンダーID を控える（CALENDAR_ID の調整）**
   - 同じ「設定と共有」画面を**下にスクロール**し、**「カレンダーを統合」** の **「カレンダーID」** をコピーする。
   - メインのカレンダーなら多くの場合 **`primary`** のまま使える。別のカレンダー（仕事用など）を使う場合は、ここでコピーした ID（例: `xxxx@group.calendar.google.com`）を `.env` の **`CALENDAR_ID=`** の右に貼り、**`primary`** と書いてある部分をそれに差し替える。

## 5. 環境変数（ローカル / GitHub Actions）

| 変数名 | 説明 | 必須 | どこに記載するか |
|--------|------|------|------------------|
| `CALENDAR_ID` | 取得対象のカレンダーID。メインのカレンダーなら **`primary`** または **自分のメール**（例: `masaki.hanawa@playground.live`） | ○ | ローカル: `.env` に1行で書く。GHA: リポジトリの **Settings → Secrets and variables → Actions** で Secret を追加 |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL（投稿先の URL） | ○ | 同上。**取得方法**: [Slack API](https://api.slack.com/apps) でアプリ作成 → **Incoming Webhooks** を ON → 「Add New Webhook to Workspace」でチャンネルを選び、表示された URL をコピー。詳しくは [slack-setup.md](slack-setup.md) 参照 |
| `GOOGLE_APPLICATION_CREDENTIALS` | サービスアカウント JSON の**ファイルパス**（ローカル用） | ローカルのみ | **どこから取得**: 上記 **「3. Google Cloud の設定」のステップ7** でダウンロードした JSON ファイルをプロジェクト直下などに置き、その**パス**を書く。**どこに記載**: `.env` に `GOOGLE_APPLICATION_CREDENTIALS=./key.json` のように1行で書く。Git にコミットしないこと |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウント JSON の**中身全体**（GitHub Actions 用） | GHA 用 | **どこから取得**: 上記 **「3. Google Cloud の設定」のステップ7** でダウンロードした JSON ファイルをテキストエディタで開いた**内容そのまま**。**どこに記載**: GHA の **Settings → Secrets and variables → Actions** で Secret 名 `GOOGLE_SERVICE_ACCOUNT_JSON` を追加し、JSON の内容をそのまま（改行を消して1行にしても可）貼る |
| `TARGET_MONTH` | 対象月 YYYY-MM。**省略時は実行時の翌月**（指定しなくてよい） | 任意 | 指定する場合のみ `.env` または GHA の Secret/環境変数に書く |

GitHub Actions では Secrets に `GOOGLE_SERVICE_ACCOUNT_JSON`（JSON 全体を1行で貼る）、`CALENDAR_ID`、`SLACK_WEBHOOK_URL` を設定してください。

## 6. 実行方法

```bash
npm run calendar-to-slack
```

GitHub Actions で「予約候補日を Slack に投稿」ワークフローを有効にすると、スケジュール（毎月15日 20:00 JST）または手動実行で動かせます。

## 7. 候補日のうち「予約してよい日」を指定する

Slack で候補日を見たあと、**実際に予約していい日**をツールに伝える方法は次の2通りです。

| 方法 | 使いどころ |
|------|------------|
| **config.yaml の `preferredDays`** | 月ごとに編集して使い回す場合。例: `preferredDays: [2, 5, 9, 16]` |
| **環境変数 `ALLOWED_DAYS`** | 実行のたびに日だけ指定したい場合。config を触らずに上書きできる。 |

**環境変数で指定する例**

```bash
# 3月の 2, 5, 9 日だけ予約対象にする
ALLOWED_DAYS=2,5,9 TARGET_MONTH=2026-03 npm run reserve
```

- `ALLOWED_DAYS` を指定すると、その日付だけが予約候補になります（`preferredDays` より優先）。
- 指定しない場合は `config.yaml` の `preferredDays` が使われます。
- `preferredDays` も空の場合は、その月の候補日はすべて対象になります。

## 8. 候補日の判定（土日祝 9:00-20:00 / 平日 18:00-20:00）

スクリプトは次のルールで候補日を判定しています。

- **1コマ1時間**、**移動で前後30分**を確保する前提で、カレンダーの「予定（busy）」が該当時間帯に1件もない日を候補とする。
- **土日祝**: 枠は 9:00〜20:00（最終枠20:00）。カレンダーが **8:30〜20:30** 空いている日を候補とする。
- **平日**: 枠は 18:00〜20:00（最終枠20:00）。カレンダーが **17:30〜20:30** 空いている日を候補とする。

祝日は **`scripts/jp-holidays.js`** で管理しています（reserve と calendar-to-slack で共有）。2年分を保持し、年が変わったら古い年を削除して新年を追加してください。時間帯を変えたい場合は `post-calendar-candidates-to-slack.js` の `WEEKEND_CHECK` / `WEEKDAY_CHECK` を編集してください。
