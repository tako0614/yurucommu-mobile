# Yurucommu Mobile

English: [README.en.md](README.en.md)

Yurucommu Mobile は、Yurucommu family のサーバーにつなぐ、フィード中心の Tauri 製モバイルクライアントです。
Takosumi からのインストール引き継ぎ、製品の Deploy to Cloudflare フロー、信頼できる QR、手入力の
HTTPS URL のいずれかでサーバーに接続できます。

Yurucommu は各自が自分用にデプロイする一人用のソフトウェアです。モバイルからも自分の
サーバーへ接続します。連合の通信相手やコミュニティの参加者は、サーバーの所有ユーザーでは
ありません。この製品前提を shared Core や Yurumeet に適用しません。

現在のユーザー、フィード、保存した投稿、未読数は、サーバーの応答を検証してから表示します。
不正な応答を空のフィードとして成功扱いにせず、更新時のエラーとして伝えます。日時のない
投稿は日時を補わず表示し、リモートの投稿者名は公開 API の規則で正規化します。保存した投稿の
失敗は画面内で再試行できます。投稿成功は投稿 ID を確認してから扱い、結果が不明なら下書きを
残して自動再送しません。認証済み引き継ぎのないブラウザ操作は表示しません。

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
