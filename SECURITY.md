# Security Policy

## 報告方法

脆弱性を見つけた場合は、公開 Issue や Pull Request に書かず、GitHub の **非公開の脆弱性報告** から送ってください。

1. https://github.com/bantojs/banto/security/advisories/new を開く（リポジトリの **Security** タブ → **Report a vulnerability**）
2. 影響する機能・再現手順・影響範囲（誰が何をできるか）を書く。ログや設定を貼るときは、鍵・トークン・個人情報を消す

受領後 **48 時間以内** に返信し、修正方針を共有します。修正版のリリース後に公開し、報告者を謝辞に記載します（希望者のみ）。
セキュリティ修正を含むリリースは、リリースノートに **[security]** と書きます（管理画面の「アップデート」にも出ます。[docs/hardening.md](docs/hardening.md) §6）。

> 運営者（メンテナ）へ: この窓口を動かすには、GitHub の Settings → Code security → **Private vulnerability reporting** を有効にしてください。
> 無効のあいだは報告が届きません。メールでの窓口を併設する場合は、ここに実在するアドレスを書き足してください。

## 対象

- `bantojs/banto` リポジトリの最新リリースおよび `main` ブランチ

## 対象外

- 運営者自身の Cloudflare / Supabase 設定ミス（推奨設定は [docs/hardening.md](docs/hardening.md)）
- 外部プラグイン（各作者へ報告してください）

## 監査の記録

- 2026-10-18: コード監査。v0.1.0 の前に直すと決めた指摘はすべて対応済みです（マイグレーション 0028〜0031・0045 と、その説明は docs/upgrade.md）
