# Yurucommu Mobile

日本語: [README.md](README.md)

Yurucommu is software each owner deploys for personal use. The mobile client connects to that owner's server;
federated contacts and community participants are not additional instance owners. This product premise does
not apply to generic Core or Yurumeet.

Current-user, feed, bookmark and unread responses are checked before display. Malformed replies are shown
as refresh errors instead of a successful empty feed. Posts with no published time keep that absence, and
remote author names follow the public API normalization rules. Bookmark failures have a local retry.
A create-post acknowledgment must include a post ID; an unconfirmed outcome retains the draft without
automatic resend. Browser shortcuts are only offered when an authenticated handoff is available.

Ordinary feed refreshes preserve the draft, visibility and pending-send state. A delayed post reply
does not overwrite later edits or an explicit clear. Accepted-send status is separate from feed readback;
a failed readback never resends the post. Replies from an earlier connection, authentication state or
sign-in do not affect the current session.

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
