# 単独リポジトリの push 手順

このフォルダは単独の Git リポジトリです。GitHub に push するまで次の 2 ステップです。

## 1. GitHub でリポジトリを作成

ブラウザで **「Create repository」** を押して空のリポジトリを作成してください。

- **Repository name**: `golf-lesson-reservation`（そのままで可）
- **Public** または **Private** を選択
- **README / .gitignore / License は追加しない**（ローカルに既にあるため）

まだ作成していない場合:  
https://github.com/new?name=golf-lesson-reservation

## 2. リモートを設定して push

リポジトリ作成後、このフォルダで実行:

```bash
cd "/Users/pg000080/Library/CloudStorage/GoogleDrive-masaki.hanawa@playground.live/マイドライブ/Dev/personal/projects/golf-lesson-reservation-repo"

# リモートは既に追加済み。別ユーザーなら URL を差し替えてから:
# git remote set-url origin https://github.com/<あなたのユーザー名>/golf-lesson-reservation.git

git push -u origin main
```

これでスケジュール（毎月23日22時・15日20時・30分ごと）が動き始めます。  
**Secrets** は GitHub の Settings → Secrets and variables → Actions で設定してください（[docs/github-actions-setup.md](docs/github-actions-setup.md) 参照）。
