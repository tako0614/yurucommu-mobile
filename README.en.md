# Yurucommu Mobile

Feed cards and saved-post previews open the existing in-app post detail. Even remote post IDs are read through the connected account's server, without an external browser handoff. Failed reads can be retried; Back preserves the compose draft and restores focus to the originating card, including its replacement after a feed refresh.

Post detail can save or remove a bookmark using the server's known state. Repeated clicks are blocked during a change, and a confirmed acknowledgment updates the action and re-reads the saved-post preview without clearing the compose draft. An unknown result never triggers an automatic resend: reload the post to reconcile its current state before another change. Account or navigation changes prevent an old acknowledgment from updating another view.

Older servers that omit bookmark state from post detail need the server-side fix before this action is available. The App does not infer “unsaved” from an absent flag. This App change does not publish a Core package or update an existing server.

Home, saved posts, notifications and post detail use a 15-second read budget through response-body consumption. A stalled body becomes a retryable error, never an empty result. Back, disposal and credential changes cancel reads that no longer belong to the view. A failed member of the parallel home load cancels its unfinished peers and cannot publish partial home data. Refresh coalescing and current-revision validation remain in place.

Post attachments are available in the feed, saved posts and notification post view. Images and videos load only after an explicit display action; failures can be retried and videos do not autoplay. Only the connected server's canonical media route receives the selected account's authorization. Public remote media remains anonymous. Private media uses temporary object URLs that are released when the account changes or its view is disposed. Invalid URLs and unsupported formats show an unavailable state. These are source/portable behaviors; device codecs and real-server use require separate verification.

The composer accepts up to eight images/videos with a caption, preserving the server's required-text contract. SDK-validated files upload serially with queued, uploading, ready and failed states. Original Unicode filenames remain in the UI/post metadata. Retry is explicit; uncertain upload/post responses never trigger automatic resends and retain the draft. Expired staged uploads must be uploaded again. An accepted post retires only its submitted files, preserving newer edits and files. Clear, account changes and disposal abort pending reads and ignore late responses. Removing a draft attachment does not delete server media; the existing server retention/cleanup lifecycle owns unused uploads. Native file selection, real-server authorization/upload and device behavior still require separate qualification.

Ordinary home-feed drafts are saved through the existing secure storage after a 150 ms input pause and restored for the same saved account after restart.
The namespace separates host, random saved row, verified home actor and API; credentials, file bytes and blob URLs are not copied to ordinary preferences.
Drafts remain until explicit clear or account removal. The last input can be lost if termination precedes its completed write.
Valid upload references restore without another upload; expired or unfinished files require reselection. The original attempted post is saved before POST, and a failed checkpoint blocks dispatch.
An interrupted or unknown post retains its original body, visibility and media separately from newer input. Restoration never automatically resends it.
Read the current actor/feed through the canonical API, then explicitly confirm review to allow the next post; this creates no delivery ACK.
A confirmed post and a failed final draft checkpoint remain distinct. Clear removes the current unsent draft while preserving any unreviewed original intent.
Unreadable data is preserved and blocks saving/posting until explicit recovery. Actual saved-row removal retires only that row, with durable cleanup retry when intent recording succeeded; absence from metadata alone is insufficient.
Replies also use the verified saved row, with separate scopes for each canonical parent and for the ordinary post view versus the profile conversation. They cannot overwrite the home draft or each other's draft.
Recovery retains the original uncertain parent/audience/community independently of newer input. Only a successful canonical replies read plus explicit review can permit the next send; restore or read failure never resends.
Changed parent settings block sending until explicit adoption of the current canonical context. Actual followers-audience choices restore, while direct recipients still require explicit mentions and the existing API validation.
Storage limits fail closed without evicting older drafts. Real saved-row removal and cleanup retry cover both home and reply scopes.
Profile editing itself still lacks cold draft recovery. Real Stronghold/OS termination, signing, device update/rollback and legitimate server/SSO qualification are not established by these source/local checks.

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

Changing credentials or the API destination cancels the previous home read and starts the current one
without waiting for that retired callback. Retired callers cannot receive the replacement connection's
home. Overlapping refreshes within the same connection remain serialized and return the latest requested home.

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

Android Back uses the same action as the visible profile, editor, post,
notification, or search screen. Drafts and search text are retained; an editor
cannot close while saving. At the feed root, the app removes its Back listener
to restore the OS default. Registration or removal failures appear in the app
with an explicit reconnect action. Default OS Back is not guaranteed until
listener removal succeeds. Source/portable checks do not replace device tests
of the physical key or Back gesture.

### Run Android from the command line

With Android SDK/NDK, a Rust Android target, a generated Android project, and a
connected device or running emulator, start the app without opening Android Studio.
Use the device name detected by Tauri, or omit it to choose a target in the CLI.

```sh
bun run tauri:android:dev "<device-name>"
```

For a physical device reaching the development server over the LAN, explicitly
provide the reachable development host IP. `--host` can follow the device name;
Tauri passes it to the shared Vite configuration as `TAURI_DEV_HOST`.

```sh
bun run tauri:android:dev "<device-name>" --host "<dev-host-ip>"
```

Add `--open` only when you want to use Android Studio:

```sh
bun run tauri:android:dev --open --host "<dev-host-ip>"
```

`bun run mobile:native-release-check` remains strict: Android/iOS generated
projects, product-owned secure keystore and APNs/FCM wiring, and local native
toolchains must all be present. `bun run mobile:release-evidence-check` verifies
the operator-private signing, store, device, OIDC, and push evidence.

An assembled APK can be inspected on a host with Android SDK build tools,
`unzip`, and `readelf`. Select the SDK's `build-tools/<version>` directory:

```sh
bun run inspect:android-apk -- /path/to/app.apk --build-tools <build-tools-dir>
```

The command compares the product's source identity, version, and deep-link schemes
with the APK, and checks its FCM service, non-debug configuration, signature state,
native libraries, and 16 KiB alignment. Use `--require-signed` to reject unsigned
APKs, or `--readelf /path/to/llvm-readelf` to select an ELF reader. A valid signature
does not establish the publisher's signing identity. This command does not sign,
install, or publish the APK and does not replace the native/device/release gates.

### Links (opening from Takosumi, screen links)

When Takosumi opens this app as a screen's native client, it fills the trusted
template for this app (`com.yurucommu`, scheme `yurucommu`) with the screen
URL's origin, URL-encoded, and sends one of:

- `yurucommu://connect?host_url=<origin>`
- `yurucommu://connect?host_url=<origin>&product=yurucommu`

Both are accepted (sign-in is never automatic). Signed out, the app finds the
server and stops before sign-in. Signed in to another server, the current
session stays usable and the server is shown as another host; the user chooses
to switch to a saved account or sign in to add it. Nothing switches silently.
Signed in to the same server, the app just opens.

Screen links `yurucommu://open?path=/…` (optionally with `host_url=`) and
`yurucommu://open?url=https://<server>/…` accept only absolute paths on the
connected server's origin. Non-http(s) URLs, paths that resolve to another
origin (`//host`, `/\host`), whitespace or control characters, and more than
2,048 characters are refused before anything opens. Links whose query,
fragment or path parameters have credential-looking names (`code`, `token`,
`access_token`, `session`, `…_token`, …) are refused too, on a best-effort
basis: the check uses a name list and endings, so a credential under another
name still passes. Links with a `code` parameter (such as `/join?code=…`) do
not open either (mobile-kit's `allowRouteCodeParameter` is not enabled).
Parameter names in the query, fragment or path must be ASCII: full-width
letters are folded to ASCII first, and a link with any other non-ASCII name
(such as `?名前=…`) does not open, so lookalike letters cannot spell a
credential name. Non-ASCII values and anchors are fine.

- `/` (the feed; a Takosumi screen URL is this) and `/bookmarks` open the
  native feed and saved posts on the home screen.
- `/notifications` opens the native notification list, and
  `/post/<URL-encoded AP ID>` opens its target post inside the app. Pagination
  uses the server cursor; failures have an explicit retry. Back preserves the
  list and feed draft. Account changes and disposal fence old responses.
  Selecting another session also retires links received before home mounted;
  returning to the original saved session does not replay them. Same-session
  home retries retain the pending link.
  Retry repeats a failed continuation; Reload deliberately starts at page one.
- Other screens are not in the app: the home screen stays and says so. They
  are not opened in an external browser, because there is no authenticated
  browser handoff.
- A link for another saved server shows that server and waits for the user to
  switch; the route opens after the switch, or after sign-in when signed out.
- Notification taps use the same route screening and account handling.
  An `event_id`-only notification opens the list; a same-host post path opens
  that post. The app does not send its bearer to another origin or open an
  unauthenticated external browser.

These are source/portable app flows. OS push delivery, real-device cold/warm
launch, signing and store distribution require separate qualification.

Until store IDs exist, Takosumi screen interfaces do not declare `clients`.
Universal links / App Links on a publisher domain are not set up.

Set `VITE_YURUCOMMU_NOTIFICATION_PUSHER_GATEWAY_URL` at build time to the public
notification pusher gateway. Provider credentials remain in that gateway and
must never be bundled into the app.

## Conversations and replies

Post detail reads replies through the selected server, with validated parent bindings, cursor pagination, explicit retry and no false empty result. Back from a nested reply restores the original rows and cursor. Ordinary Notes reuse the feed composer, attachments and bounded request lifecycle. Unknown parent reach permits reading but does not infer a public reply.

Community replies retain the actual parent community. A followers-scoped parent requires an explicit choice between the replier's followers and a direct reply: the original audience can differ. Direct recipients must be explicit mentions, resolved through the existing server actor API before POST. The author-add action visibly edits the draft; it never adds a hidden recipient.

The existing Core creation ACK omits the parent. Within the same 15-second mutation budget the App reads the returned ID through the selected server and verifies parent, author, visibility and community. Unknown results retain the draft and never auto-resend. Accepted posting and failed refresh remain separate. Back pauses requests while keeping the same-target draft and files; changing targets cannot silently discard them. Account changes and disposal retire drafts, requests and temporary URLs. Story or unknown reach remains read-only. These source/local checks do not establish remote delivery, installed-server adoption or native-device readiness.

Qualified mentions of local recipients also require the paired Core resolver repair. This App source change neither republishes an older Core package nor updates installed servers. A confirmed stored reply does not prove receipt or external delivery.

### Post likes and recovery

Feed, saved-post, detail and reply cards support like/unlike through the selected
server. A missing raw viewer `liked` flag remains unknown: the app offers an
explicit state read before enabling changes. Counts come from the persisted post
GET, with no local increment/decrement. The mutation ACK and persisted read share
the existing 15-second budget.

An uncertain ACK, refusal or mismatched readback disables mutation until an
explicit read succeeds. Recovery never automatically resends a mutation. Cards for the same post share
pending, uncertain and confirmed state, preventing cross-card duplicate writes.
A read started before the change cannot downgrade its confirmed viewer flag/count. When the last visible card for a post leaves the screen, or the account changes,
the app retires its old request and fences late results. Cancellation does not promise server-side rollback.
Portable/local HTTP/intercepted-browser checks do not qualify real device login,
installed servers, push delivery or distribution.

### Native profiles

Author actions in feed, saved posts, details, replies and notifications open a
profile and its posts through the selected server. Own-profile and selected-host
`/profile`, `/profile/<identifier>` and `/users/<username>` links stay in the app.
No bearer is sent to an actor's origin and no authenticated browser is assumed.

Post lists support continuation, retry and returning from details. The original
view's draft and the profile conversation draft remain independent. Switching to
a different profile asks before discarding that conversation's draft, media or
uncertain send result. Missing remote counts remain unknown.

Follow, request cancellation and unfollow first verify the selected viewer and
canonical target. Pending requests stay distinct from accepted follows. Each
change requires an ACK and persisted relationship/count readback; an unknown
outcome requires an explicit state read, with no automatic resend. Closing or
switching profiles retains an uncertain result, while changing accounts retires
the old operation. Self-follow and writes without raw server relationship state
are unavailable. Remote delivery depends on the connected server federation
runtime; local App checks do not qualify delivery.

### Edit your profile

The existing own-profile action opens an editor for name, bio, avatar, header,
follow approval and up to four metadata rows. It uses the server limits: name
50 characters, bio 500, metadata labels/values 255 each. JPEG, PNG, GIF and WebP
images reuse the existing media upload path; explicit URL input and removal are
also supported.

Only changed fields are submitted. A save verifies the current viewer, ACK,
canonical stored profile and final viewer within one 15-second budget. Later
per-field edits survive an earlier ACK. Unknown outcomes retain the draft and
require an explicit read without automatic resubmission. Reads merge current
stored values without clearing newer edits; discarding input requires confirmation.
Drafts remain in memory for the current account; changing accounts retires its
operations.

Profile images load on explicit action. Only canonical selected-host media gets
the bearer, and authenticated image responses must have a supported actual MIME
and bounded body. Public remote images receive no bearer. Hiding the profile
releases pending reads and object URLs. Stored profile, current readback, home
refresh and federation delivery are separate outcomes; local App checks do not
qualify real devices, genuine login, deployed hosts or remote delivery.

Post details offer deletion only when the current viewer matches the author.
After confirmation, the App rechecks the current identity and calls the existing
owner-only DELETE API. It returns to the list only after a successful receipt
and a same-server read confirms absence, then refreshes home, bookmarks and the
profile. A reply draft, attachment or pending reply blocks deletion. Failure or
an unknown outcome keeps the detail and requires an explicit reload without
automatic resend. Retired view/account responses cannot update the new view.
These are App source/portable behaviors, separate from device, installed-server
and ActivityPub delivery qualification.

Own-post details offer an inline editor for text and content warnings. The editor
uses the server's original string without reconstructing it from displayed HTML.
The limits match the existing edit contract: 5,000 content characters and 500
warning characters. PATCH includes changed fields only; an empty string removes
an existing warning. Audience, visibility and attachments remain unchanged.
New input survives an in-flight save. Unknown outcomes require explicit GET
recovery without automatic resend. Closing and reopening the same post retains
its edit; moving to another post asks before discarding unsaved work. Confirmed
text updates conversations, profiles, home and bookmarks without allowing older
reads to restore it. Changing only the selected API endpoint also retires the
previous operation scope. Preflight detects fields already changed by another
writer, but the existing API has no atomic edit CAS, so a subsequent writer may
still race it. App source/local evidence does not qualify devices or deployment.

Posts with content warnings start collapsed in home, bookmarks, details, replies
and profiles. Each card offers explicit show/hide controls for its text and media;
media still requires its existing explicit load action after revealing the post.
Disclosure stays local to the card and resets when content, warning, attachment,
connection or account changes, or when the surface becomes inactive.

Home offers explicit continuation beyond the first 20 posts using the server's
opaque cursor, with duplicate boundary posts removed. Failed reads retain the
current rows and composer draft; retry reads the same cursor only on request.
Leaving the surface cancels an unfinished page, and a new first-page read or
connection/account change retires the previous continuation. Confirmed edits and
deletions also project into added pages. Legacy responses without continuation
metadata remain readable but do not establish either a next page or the end.
These are source/local behaviors, separate from device and deployed use.

## Search in the app

Use the feed's search action to find posts and users through the connected server's existing search APIs.
Typing does not make requests; submit the query explicitly. `#tag` uses the existing exact-tag endpoint.
Open a result's post or profile and return without losing the query, results, pagination position, or home composer draft.
Failures remain visible and can be retried explicitly for the original query or page, preserving newer unsent input.
The app accepts the web client's `/search?search=<query>&tab=posts` and `tab=users` links.
Without a tab it checks both result types, selecting users when found and posts otherwise, as the web client does.
Community tabs remain unsupported. Search does not add remote delivery or WebFinger lookups.
Changing account or API endpoint retires pending reads and clears the prior account's query and results.
Source/local search checks do not qualify real-device login, deployment, or distribution.
