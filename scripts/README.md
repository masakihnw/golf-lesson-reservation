# 予約自動化スクリプト

Playwright を使ったゴルフレッスン予約の自動化プロトタイプです。

## 前提

- Node.js 18+
- 設定ファイル `config.yaml` と環境変数（`.env`）で認証情報・条件を設定する

## セットアップ

```bash
# 依存関係
npm install

# Chromium のインストール（Playwright 用）
npx playwright install chromium

# 設定ファイル（リポジトリ直下で実行）
cp config.example.yaml config.yaml
cp .env.example .env

# config.yaml を編集（対象月・希望日・時間帯など）
# .env を編集（GOLF_RESERVATION_EMAIL, GOLF_RESERVATION_PASSWORD）
```

## 実行

```bash
# ヘッドレス（バックグラウンド）で実行
npm run reserve

# ブラウザを表示して実行（デバッグ用）
npm run reserve:headed
# または
HEADED=1 npm run reserve
```

## 設定（config.yaml）と「条件」の意味

**〇を探すときの条件**は、次の設定を使います。**config.yaml を編集して指定**してください。

| 項目 | 説明 | 例 | 未指定時 |
|------|------|-----|----------|
| `targetMonth` | 予約対象月 | `"2026-02"` | 必須 |
| `preferredDays` | **希望する日**（月の日付。この日付の〇だけ予約対象） | `[1,2,3,7,8,25,26,27,28]` | **空なら「どの日でも可」** |
| `timeRange.start` / `end` | **希望時間帯**（時）。この時間帯の〇だけ予約対象 | `17` 〜 `18` → 17時〜18時 | 未指定時は 17〜18 を想定 |
| `reservationOpensAt` | その月の予約開始日時（任意） | `day: 23, hour: 22, minute: 0` | 23日22時 |
| `maxSlots` | 予約する最大枠数 | `2` | 2 |
| `maxWaitlist` | キャンセル待ちの最大件数 | `10` | 10 |
| `baseUrl` | サイトのベースURL | `"https://appy-epark.com"` | 変更不要 |

- **preferredDays**: 例では 1,2,3,7,8 と 25〜28 を指定＝月初と月末の日だけ狙う（中1週を避ける）。
- **timeRange**: 例では 17〜18 時＝17:00〜17:50 などの枠だけ予約する。
- **予約の優先**: 条件に合う枠が複数あるときは **土日祝 > 平日** の順で優先して予約する。1件目・2件目とも土日祝を優先し、2件目はそのうえで「月内で均等な間隔」になる日を選ぶ。
- **祝日**: `scripts/jp-holidays.js` で 2年分（2026・2027）を管理。reserve と post-calendar-candidates-to-slack で共有。年が変わったら古い年を削除して新年を追加する。

スクリプトは「〇をクリック → 予約詳細の日付・時刻を読む → preferredDays と timeRange に合うときだけ予約」します。

## 環境変数（.env）

| 変数名 | 説明 |
|--------|------|
| `GOLF_RESERVATION_EMAIL` | ログイン用メールアドレス |
| `GOLF_RESERVATION_PASSWORD` | ログイン用パスワード |

## フロー（スクリプトの動作）

1. ログイン画面でメール・パスワードを入力してログイン
2. マイページで「空枠確認・予約する」をクリック
3. 「各種50分枠レッスン」をクリック
4. 予約カレンダーで「次の一週間」を必要な回数クリックし、対象月の週を表示
5. カレンダー表で **〇**（予約可能）のセルを探し、最初の1件をクリック
6. 予約詳細で「ペアレッスン」にチェックを入れ、「予約する」をクリック
7. 2枠目がある場合はカレンダーに戻り、同様にもう1件予約

## 注意

- **ログインURL**: サイトによってログイン画面のパスが異なります。`config.yaml` の `loginPath` で指定できます（デフォルト: `/users/login.php`）。ログインに失敗する場合は実際のURLを確認して設定してください。
- **セレクタ**: 実際のHTML構造に合わせて `scripts/reserve.js` 内のセレクタを調整する必要がある場合があります。まずは `npm run reserve:headed` でブラウザを表示して動作を確認してください。
- **予約開始日時**: `reservationOpensAt` は現状「いつ実行するか」のスケジュール用です。実際の実行は GAS や GitHub Actions のトリガーで 23日22時（または指定日時）に実行する想定です。
- **起動通知**: スクリプト起動時の Slack 通知は未実装です。GAS / GitHub Actions 側で「ジョブ開始」を通知する実装を追加してください。

## 今後の拡張

- 希望日・希望時間帯でフィルタして〇を選択（現在は最初の〇をクリック）
- GAS または GitHub Actions で 23日22時（または `reservationOpensAt`）に実行
- 起動時・完了時の Slack 通知
