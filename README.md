# Yurucommu Mobile

English: [README.en.md](README.en.md)

Yurucommu Mobile は、Yurucommu family のサーバーにつなぐ、フィード中心の Tauri 製モバイルクライアントです。
Takosumi からのインストール引き継ぎ、製品の Deploy to Cloudflare フロー、信頼できる QR、手入力の
HTTPS URL のいずれかでサーバーに接続できます。

ログインは、サーバーが広告する OIDC PKCE フローとホストのパスワードセッションの両方に対応します。
どちらの方式でも、製品 API を呼ぶ前に失効可能なホスト bearer token に交換されます。

## 始め方

この repo の隣に standalone `mobile-kit` checkout が `../mobile-kit` として必要です。

```sh
bun install --frozen-lockfile
bun run mobile:check
```

アプリの製品 API contract は公開 package `@takosjp/yurucommu-api`、モバイル共通基盤は
独立 repo の `@takosjp/mobile-kit` を使います。Takosumi source checkout には依存しません。
OIDC は接続先が `/.well-known/yurucommu` で広告する operator 登録済み native public client
だけを使い、要求 scope は `openid profile` に限定します。

この Tauri shell は iOS / Android 専用です。desktop では Yurucommu web client を使ってください。

## リリースチェック

- `bun run mobile:native-release-check` — Android/iOS の生成プロジェクト、製品所有の secure keystore と
  APNs/FCM の配線、ローカルの native toolchain がすべて揃っていることを厳密に確認します
- `bun run mobile:release-evidence-check` — operator 私有の署名・ストア・実機・OIDC・push の証跡を確認します

## 通知

ビルド時に `VITE_YURUCOMMU_NOTIFICATION_PUSHER_GATEWAY_URL` に公開の notification pusher gateway URL を
設定します。プロバイダ credential は gateway 側にだけ置き、アプリには決して同梱しません。
