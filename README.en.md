# Yurucommu Mobile

Feed-first Tauri client for a Yurucommu family server. It can connect through a
Takosumi install handoff, the product's direct Deploy to Cloudflare flow, a
trusted QR payload, or a manually entered HTTPS URL.
Authentication supports a host-advertised OIDC PKCE flow and host password
sessions; both become a revocable host bearer before product API calls.

```sh
bun install --frozen-lockfile
bun run mobile:check
```

The checkout must have the standalone `mobile-kit` source beside this
repository as `../mobile-kit`. Product API types and calls come from the public
`@takosjp/yurucommu-api` package; this shell does not depend on a Takosumi
source checkout. OIDC uses only the operator-registered native public client
advertised by the connected host and requests only `openid profile`.

This Tauri shell ships for iOS and Android only. Use the Yurucommu web client
on desktop.

`bun run mobile:native-release-check` remains strict: Android/iOS generated
projects, product-owned secure keystore and APNs/FCM wiring, and local native
toolchains must all be present. `bun run mobile:release-evidence-check` verifies
the operator-private signing, store, device, OIDC, and push evidence.

Set `VITE_YURUCOMMU_NOTIFICATION_PUSHER_GATEWAY_URL` at build time to the public
notification pusher gateway. Provider credentials remain in that gateway and
must never be bundled into the app.
