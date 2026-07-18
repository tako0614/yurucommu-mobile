# Yurucommu Mobile

Feed-first Tauri client for a Yurucommu family server. It can connect through a
Takosumi install handoff, the product's direct Deploy to Cloudflare flow, a
trusted QR payload, or a manually entered HTTPS URL.
Authentication supports a host-advertised OIDC PKCE flow and host password
sessions; both become a revocable host bearer before product API calls.

```sh
bun run bootstrap
bun run mobile:check
```

The checkout must have the Takosumi source beside this repository as
`../takosumi`. `bootstrap` installs Takosumi's locked source-module workspace
and this app's locked dependencies; the app declares both `mobile-kit` and its
contract package explicitly, so a clean checkout does not rely on pre-existing
parent `node_modules` state.

`bun run mobile:native-release-check` remains strict: Android/iOS generated
projects, product-owned secure keystore and APNs/FCM wiring, and local native
toolchains must all be present. `bun run mobile:release-evidence-check` verifies
the operator-private signing, store, device, OIDC, and push evidence.

Set `VITE_YURUCOMMU_NOTIFICATION_PUSHER_GATEWAY_URL` at build time to the public
notification pusher gateway. Provider credentials remain in that gateway and
must never be bundled into the app.
