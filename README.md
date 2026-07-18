# Yurucommu Mobile

English: [README.en.md](README.en.md)

Yurucommu Mobile は、Yurucommu family のサーバーにつなぐ、フィード中心の Tauri 製モバイルクライアントです。
Takosumi からのインストール引き継ぎ、製品の Deploy to Cloudflare フロー、信頼できる QR、手入力の
HTTPS URL のいずれかでサーバーに接続できます。

ログインは、サーバーが広告する OIDC PKCE フローとホストのパスワードセッションの両方に対応します。
どちらの方式でも、製品 API を呼ぶ前に失効可能なホスト bearer token に交換されます。

## 始め方

この repo の隣に Takosumi の source checkout が `../takosumi` として必要です。

```sh
bun run bootstrap
bun run mobile:check
```

`bootstrap` は Takosumi 側の locked source-module workspace とこのアプリの locked 依存を
インストールします。`mobile-kit` と contract package はこのアプリが明示的に宣言しているので、
親ディレクトリの `node_modules` の状態には依存しません。

## リリースチェック

- `bun run mobile:native-release-check` — Android/iOS の生成プロジェクト、製品所有の secure keystore と
  APNs/FCM の配線、ローカルの native toolchain がすべて揃っていることを厳密に確認します
- `bun run mobile:release-evidence-check` — operator 私有の署名・ストア・実機・OIDC・push の証跡を確認します

## 通知

ビルド時に `VITE_YURUCOMMU_NOTIFICATION_PUSHER_GATEWAY_URL` に公開の notification pusher gateway URL を
設定します。プロバイダ credential は gateway 側にだけ置き、アプリには決して同梱しません。
