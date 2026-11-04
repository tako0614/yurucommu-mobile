import {
  normalizeNotificationPusherGatewayUrl,
  registerNotificationPusherWithHost,
  unregisterNotificationPusherWithHost,
  type MobilePushRegistrationCallbackInput,
  type MobileSession,
} from "@takosjp/mobile-kit";
import {
  apiFetch,
  assertOk,
  clearYurucommuApiTransport,
  createPost as createYurucommuPost,
  normalizeActor,
  setYurucommuApiTransport,
  type Actor,
  type ApiTransport,
  type Post,
  type MediaAttachment,
  validateFile,
  FileValidationError,
} from "@takosjp/yurucommu-api";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";

export type MobileActor = Pick<
  Actor,
  "ap_id" | "preferred_username" | "name" | "icon_url"
>;

export type MobilePostVisibility = Post["visibility"];
export interface MobileReplyTarget {
  readonly apId: string;
  readonly communityApId: string | null;
}

export type MobilePost = Pick<
  Post,
  "ap_id" | "content" | "like_count" | "reply_count" | "author"
> & {
  published: string | null;
  attachments?: Post["attachments"];
  readonly likeState?: boolean | null;
};

export interface YurucommuMobileHome {
  actor: MobileActor;
  posts: MobilePost[];
  unread: number;
}

export async function loadHome(
  session: MobileSession,
  signal?: AbortSignal,
): Promise<YurucommuMobileHome> {
  const selected = snapshotFeedSession(session);
  return withMobileReadScope(selected, signal, async (request) => {
    const [actor, timeline, unread] = await Promise.all([
      fetchMobileCurrentActor(request),
      fetchMobileTimeline(request, selected),
      fetchMobileUnreadCount(request),
    ]);
    return { actor, posts: timeline, unread };
  });
}

export type MobileReadRequest = (path: string) => Promise<Response>;

/** Product-owned read lifetime; decoding stays inside its header+body budget. */
export async function withMobileReadScope<T>(
  session: MobileSession,
  signal: AbortSignal | undefined,
  read: (request: MobileReadRequest) => Promise<T>,
): Promise<T> {
  const selected = snapshotFeedSession(session),
    owned = new AbortController();
  const cancel = () => owned.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(
    () =>
      owned.abort(
        new Error(
          "読み込みを時間内に完了できませんでした。再試行してください。",
        ),
      ),
    15_000,
  );
  const request: MobileReadRequest = (path) => {
    if (owned.signal.aborted) return Promise.reject(owned.signal.reason);
    // The SDK's default timer detaches the caller signal at headers. Its
    // supported direct-signal option keeps this owner attached through JSON.
    return withYurucommuMobileTransport(selected, () =>
      apiFetch(path, {
        signal: owned.signal,
        timeoutMs: 0,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
  };
  try {
    if (owned.signal.aborted) throw owned.signal.reason;
    return await read(request);
  } catch (cause) {
    if (owned.signal.aborted) throw owned.signal.reason;
    throw cause;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    // On a batch failure, stop its other unfinished responses too.
    owned.abort();
  }
}

export async function createPost(
  session: MobileSession,
  content: string,
  visibility: MobilePostVisibility = "public",
  attachments: readonly MediaAttachment[] = [],
  signal?: AbortSignal,
  replyTo?: MobileReplyTarget,
): Promise<void> {
  if (
    replyTo &&
    (!nonEmptyString(replyTo.apId) ||
      (replyTo.communityApId !== null &&
        !nonEmptyString(replyTo.communityApId)))
  )
    throw new Error("返信先の投稿を確認できませんでした。");
  const selected = snapshotFeedSession(session),
    abort = new AbortController();
  const cancel = () => abort.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(
    () => abort.abort(new Error("投稿の結果を時間内に確認できませんでした。")),
    15_000,
  );
  const request: MobileReadRequest = (path) => {
    if (abort.signal.aborted) return Promise.reject(abort.signal.reason);
    return withYurucommuMobileTransport(selected, () =>
      apiFetch(path, {
        signal: abort.signal,
        timeoutMs: 0,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
  };
  try {
    if (abort.signal.aborted) throw abort.signal.reason;
    if (replyTo && visibility === "direct") {
      const mentions = [
        ...new Set(
          Array.from(
            content.matchAll(/@([a-zA-Z0-9_]+(?:@[a-zA-Z0-9.-]+)?)/g),
            (match) => match[1]!,
          ),
        ),
      ];
      if (!mentions.length)
        throw new Error("ダイレクト返信の宛先を本文で指定してください。");
      // Core skips self mentions. Read the actual selected identity instead of
      // inferring it from an OIDC subject or a display handle.
      const self = await fetchMobileCurrentActor(request);
      let hasRecipient = false;
      // Core may silently skip unresolved mentions. Resolve every explicit
      // handle through its existing selected-server actor API before POST.
      for (const mention of mentions) {
        if (abort.signal.aborted) throw abort.signal.reason;
        const [username, domain] = mention.split("@");
        const lookup = domain ? `${username}@${domain.toLowerCase()}` : mention;
        const response = await request(
          `/api/actors/${encodeURIComponent(lookup)}`,
        );
        if (!response.ok)
          throw new Error(
            `宛先 @${mention} を確認できませんでした。返信は送信していません。`,
          );
        const value = await readMutationAcknowledgement(
          response,
          128 * 1024,
          "宛先の確認",
        );
        if (
          !isRecord(value) ||
          !isRecord(value.actor) ||
          !nonEmptyString(value.actor.ap_id) ||
          value.actor.preferred_username !== username
        )
          throw new Error(`宛先 @${mention} の応答を確認できませんでした。`);
        const identity = new URL(value.actor.ap_id);
        if (
          !["http:", "https:"].includes(identity.protocol) ||
          identity.username ||
          identity.password ||
          (domain !== undefined &&
            identity.host.toLowerCase() !== domain.toLowerCase())
        )
          throw new Error(`宛先 @${mention} のサーバーが一致しません。`);
        if (value.actor.ap_id !== self.ap_id) hasRecipient = true;
      }
      if (!hasRecipient)
        throw new Error(
          "自分以外のダイレクト返信の宛先を本文で指定してください。返信は送信していません。",
        );
    }
    if (abort.signal.aborted) throw abort.signal.reason;
    const body: Parameters<typeof createYurucommuPost>[0] = {
      content,
      visibility,
      ...(replyTo
        ? {
            in_reply_to: replyTo.apId,
            ...(replyTo.communityApId === null
              ? {}
              : { community_ap_id: replyTo.communityApId }),
          }
        : {}),
      ...(attachments.length
        ? {
            attachments: attachments.map(
              ({ r2_key, content_type, url, name }) => ({
                r2_key,
                content_type,
                ...(url === undefined ? {} : { url }),
                ...(name === undefined ? {} : { name }),
              }),
            ),
          }
        : {}),
    };
    // Keep the public SDK request/type contract while retaining cancellation
    // through the ACK body (SDK3.4 createPost has no caller-signal parameter).
    const response = await withYurucommuMobileTransport(selected, () =>
      apiFetch("/api/posts", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        timeoutMs: 0,
        signal: abort.signal,
        redirect: "error",
        cache: "no-store",
      }),
    );
    if (!response.ok) throw await mutationError(response, "投稿");
    const value = await readMutationAcknowledgement(
      response,
      128 * 1024,
      "投稿",
    );
    if (
      !isRecord(value) ||
      !isRecord(value.post) ||
      !nonEmptyString(value.post.ap_id)
    )
      throw new Error(
        replyTo
          ? "返信の結果を確認できませんでした。再送する前に返信一覧を確認してください。"
          : "投稿の結果を確認できませんでした。再送する前にフィードを確認してください。",
      );
    if (replyTo) {
      if (
        !isRecord(value.post.author) ||
        !nonEmptyString(value.post.author.ap_id)
      )
        throw new Error("返信の送信者を確認できませんでした。");
      const acceptedId = value.post.ap_id,
        acceptedAuthor = value.post.author.ap_id;
      if (abort.signal.aborted) throw abort.signal.reason;
      if (value.post.mention_processing !== undefined) {
        const mentions = value.post.mention_processing;
        if (
          !isRecord(mentions) ||
          typeof mentions.failed_count !== "number" ||
          !Number.isSafeInteger(mentions.failed_count) ||
          mentions.failed_count < 0 ||
          mentions.failed_count > 0
        )
          throw new Error(
            "返信は保存された可能性がありますが、宛先の処理を確認できませんでした。返信一覧を確認してください。",
          );
      }
      // The current producer ACK omits in_reply_to. Confirm the saved object
      // via the selected server, never by fetching the returned AP ID directly.
      const readback = await request(
        `/api/posts/${encodeURIComponent(acceptedId)}`,
      );
      if (!readback.ok) throw await mutationError(readback, "返信の確認");
      const saved = await readMutationAcknowledgement(
        readback,
        128 * 1024,
        "返信の確認",
      );
      if (
        !isRecord(saved) ||
        !isRecord(saved.post) ||
        saved.post.ap_id !== acceptedId ||
        saved.post.in_reply_to !== replyTo.apId ||
        saved.post.visibility !== visibility ||
        saved.post.community_ap_id !== replyTo.communityApId ||
        !isRecord(saved.post.author) ||
        saved.post.author.ap_id !== acceptedAuthor
      )
        throw new Error(
          "保存された返信の宛先または公開範囲を確認できませんでした。",
        );
      if (abort.signal.aborted) throw abort.signal.reason;
    }
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
  }
}

export interface MobileUploadedAttachment extends MediaAttachment {
  readonly expiresAt?: string;
}

const uploadExtensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export function validateMobileUpload(file: File): void {
  if (!file.size) throw new Error("空のファイルは添付できません。");
  // Core names stored media by generated ID/MIME, never by the input basename.
  // Keep Unicode names as user-facing metadata; SDK3.4 only accepts ASCII names
  // on the multipart File. Defer only its basename failure, then fully validate
  // the actual renamed multipart File before sending it.
  try {
    validateFile(file);
  } catch (cause) {
    if (cause instanceof FileValidationError) {
      // The real multipart File is renamed and fully revalidated below.
      if (cause.code === "INVALID_FILENAME") return;
      throw new Error(
        cause.code === "FILE_TOO_LARGE"
          ? "ファイルがアップロードできるサイズを超えています。"
          : "このファイル形式は添付できません。JPEG・PNG・GIF・WebP・MP4・WebMを選んでください。",
        { cause },
      );
    }
    throw cause;
  }
}

async function multipartUploadFile(file: File): Promise<File> {
  // An independent buffer also avoids Bun1.3.14's shared File-name metadata
  // when constructing a File from another File/slice. Uploads are serialized.
  return new File(
    [await file.arrayBuffer()],
    `attachment.${uploadExtensions[file.type] ?? "bin"}`,
    { type: file.type, lastModified: file.lastModified },
  );
}

/** Published multipart endpoint + existing selected-account SDK transport. */
export async function uploadPostMedia(
  session: MobileSession,
  file: File,
  signal: AbortSignal,
): Promise<MobileUploadedAttachment> {
  const displayName = file.name.slice(0, 255);
  const selectedSession = snapshotFeedSession(session);
  validateMobileUpload(file);
  if (signal.aborted) throw signal.reason;
  const abort = new AbortController();
  const cancel = () => abort.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(
    () =>
      abort.abort(
        new Error("アップロードの結果を時間内に確認できませんでした。"),
      ),
    60_000,
  );
  try {
    const multipartFile = await multipartUploadFile(file);
    validateFile(multipartFile);
    if (abort.signal.aborted) throw abort.signal.reason;
    const form = new FormData();
    form.append("file", multipartFile);
    // SDK uploadMedia has no caller signal. Reuse its public apiFetch and
    // validateFile primitives so cancellation covers both upload and ACK body.
    const response = await withYurucommuMobileTransport(selectedSession, () =>
      apiFetch("/api/media/upload", {
        method: "POST",
        body: form,
        timeoutMs: 0,
        signal: abort.signal,
        redirect: "error",
        cache: "no-store",
      }),
    );
    if (!response.ok) {
      throw await mutationError(response, "アップロード");
    }
    const value: unknown = await readMutationAcknowledgement(
      response,
      16 * 1024,
      "アップロード",
    );
    if (
      !isRecord(value) ||
      typeof value.r2_key !== "string" ||
      !/^uploads\/[a-f0-9]+\.(jpg|png|gif|webp|mp4|webm)$/u.test(
        value.r2_key,
      ) ||
      !value.r2_key.endsWith(`.${uploadExtensions[file.type]}`) ||
      value.content_type !== file.type ||
      typeof value.url !== "string" ||
      value.url !== value.url.trim() ||
      /[\u0000-\u0020]/u.test(value.url)
    )
      throw new Error("アップロードの応答を確認できませんでした。");
    const host = new URL(selectedSession.hostUrl),
      url = new URL(value.url, host);
    const path = `/media/${value.r2_key.slice("uploads/".length)}`;
    if (
      url.origin !== host.origin ||
      url.pathname !== path ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("アップロード先の応答を確認できませんでした。");
    if (
      value.expires_at !== undefined &&
      (typeof value.expires_at !== "string" ||
        !Number.isFinite(Date.parse(value.expires_at)) ||
        Date.parse(value.expires_at) <= Date.now())
    )
      throw new Error("添付の有効期限を確認できませんでした。");
    return {
      r2_key: value.r2_key,
      url: path,
      content_type: file.type,
      name: displayName,
      ...(value.expires_at === undefined
        ? {}
        : { expiresAt: value.expires_at as string }),
    };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
  }
}

async function readMutationAcknowledgement(
  response: Response,
  maximum: number,
  operation: string,
): Promise<unknown> {
  if (
    !response.body ||
    Number(response.headers.get("content-length") ?? 0) > maximum
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`${operation}の応答を確認できませんでした。`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum)
        throw new Error(`${operation}の応答が大きすぎます。`);
      chunks.push(new Uint8Array(value));
    }
    return JSON.parse(await new Blob(chunks).text());
  } catch (cause) {
    void reader.cancel().catch(() => {});
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

async function mutationError(
  response: Response,
  operation: string,
): Promise<Error> {
  let message = `${operation}できませんでした（${response.status}）。`;
  try {
    const value = await readMutationAcknowledgement(
      response,
      16 * 1024,
      operation,
    );
    if (isRecord(value) && nonEmptyString(value.error))
      message += ` ${value.error.slice(0, 500)}`;
  } catch {
    void response.body?.cancel().catch(() => {});
  }
  return new Error(message);
}

// Client read provenance is kept out of wire objects/JSON. A read that began
// before a mutation cannot later downgrade its confirmed viewer state.
const postLikeReads = new WeakMap<
  object,
  { scope: string; startedAt: number }
>();
const likeScope = (session: MobileSession) =>
  JSON.stringify([feedSessionIdentity(session), session.apiBaseUrl]);
export function recordMobilePostLikeRead<T extends object>(
  post: T,
  session: MobileSession,
  startedAt: number,
): T {
  postLikeReads.set(post, { scope: likeScope(session), startedAt });
  return post;
}
export function mobilePostLikeReadStartedAt(
  post: object,
  session: MobileSession,
): number | null {
  const stamp = postLikeReads.get(post);
  return stamp?.scope === likeScope(session) ? stamp.startedAt : null;
}

export interface MobilePostLikeReceipt {
  readonly ap_id: string;
  readonly likeState: boolean;
  readonly like_count: number;
}

function decodePostLike(value: unknown, apId: string): MobilePostLikeReceipt {
  if (
    !isRecord(value) ||
    !isRecord(value.post) ||
    value.post.ap_id !== apId ||
    typeof value.post.liked !== "boolean" ||
    typeof value.post.like_count !== "number" ||
    !Number.isSafeInteger(value.post.like_count) ||
    Number(value.post.like_count) < 0
  )
    throw new Error("いいねの状態を確認できませんでした。");
  return {
    ap_id: apId,
    likeState: value.post.liked,
    like_count: value.post.like_count,
  };
}

export async function loadMobilePostLike(
  session: MobileSession,
  apId: string,
  signal?: AbortSignal,
): Promise<MobilePostLikeReceipt> {
  if (!nonEmptyString(apId)) throw new Error("投稿の識別子が不正です。");
  return withMobileReadScope(session, signal, async (request) => {
    const response = await request(`/api/posts/${encodeURIComponent(apId)}`);
    if (!response.ok) throw await mutationError(response, "いいねの確認");
    return decodePostLike(
      await readMutationAcknowledgement(response, 128 * 1024, "いいねの確認"),
      apId,
    );
  });
}

export async function setMobilePostLike(
  session: MobileSession,
  apId: string,
  liked: boolean,
  signal?: AbortSignal,
): Promise<MobilePostLikeReceipt> {
  if (!nonEmptyString(apId)) throw new Error("投稿の識別子が不正です。");
  const selected = snapshotFeedSession(session),
    owned = new AbortController();
  const cancel = () => owned.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(
    () =>
      owned.abort(new Error("いいねの結果を時間内に確認できませんでした。")),
    15_000,
  );
  const request = (path: string, method = "GET") => {
    if (owned.signal.aborted) return Promise.reject(owned.signal.reason);
    return withYurucommuMobileTransport(selected, () =>
      apiFetch(path, {
        method,
        signal: owned.signal,
        timeoutMs: 0,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
  };
  try {
    const path = `/api/posts/${encodeURIComponent(apId)}`;
    const response = await request(`${path}/like`, liked ? "POST" : "DELETE");
    if (!response.ok) throw await mutationError(response, "いいねの変更");
    const value = await readMutationAcknowledgement(
      response,
      16 * 1024,
      "いいねの変更",
    );
    if (!isRecord(value) || value.success !== true || value.liked !== liked)
      throw new Error("いいねの変更結果を確認できませんでした。");
    // ACK has no count. Read the persisted viewer state instead of adjusting a
    // count locally or trusting SDK defaults for missing fields.
    const readback = await request(path);
    if (!readback.ok) throw await mutationError(readback, "いいねの確認");
    const saved = decodePostLike(
      await readMutationAcknowledgement(readback, 128 * 1024, "いいねの確認"),
      apId,
    );
    if (saved.likeState !== liked)
      throw new Error("いいねの保存状態が変更結果と一致しません。");
    if (owned.signal.aborted) throw owned.signal.reason;
    return saved;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function setMobilePostBookmark(
  session: MobileSession,
  apId: string,
  bookmarked: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!nonEmptyString(apId)) throw new Error("投稿の識別子が不正です。");
  const selected = snapshotFeedSession(session),
    owned = new AbortController();
  const cancel = () => owned.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(
    () => owned.abort(new Error("保存結果を時間内に確認できませんでした。")),
    15_000,
  );
  try {
    if (owned.signal.aborted) throw owned.signal.reason;
    // Keep the public SDK's encoded selected-host route; its void helpers do
    // not expose a caller signal or validate the mutation acknowledgment.
    const response = await withYurucommuMobileTransport(selected, () =>
      apiFetch(`/api/posts/${encodeURIComponent(apId)}/bookmark`, {
        method: bookmarked ? "POST" : "DELETE",
        signal: owned.signal,
        timeoutMs: 0,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
    if (!response.ok) throw await mutationError(response, "保存の変更");
    const value = await readMutationAcknowledgement(
      response,
      16 * 1024,
      "保存",
    );
    if (
      !isRecord(value) ||
      value.success !== true ||
      value.bookmarked !== bookmarked
    )
      throw new Error("保存結果を確認できませんでした。");
  } catch (cause) {
    if (owned.signal.aborted) throw owned.signal.reason;
    throw cause;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    owned.abort();
  }
}

export async function loadYurucommuMobileBookmarksPage(
  session: MobileSession,
  signal?: AbortSignal,
): Promise<MobilePost[]> {
  const selected = snapshotFeedSession(session);
  return withMobileReadScope(selected, signal, async (request) => {
    const startedAt = performance.now();
    const response = await request("/api/bookmarks?limit=8");
    await assertOk(response, "Failed to load bookmarks");
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.posts)) {
      throw new Error("Yurucommu bookmarks response is invalid.");
    }
    return value.posts.map((post) =>
      recordMobilePostLikeRead(decodeMobilePost(post), selected, startedAt),
    );
  });
}

/**
 * Adapt the host-scoped native session to the public Yurucommu client SDK.
 * The SDK transport is process-global, so callers install it only while they
 * synchronously create their request promises; no bearer remains registered
 * after that point.
 */
export function createYurucommuMobileTransport(
  session: MobileSession,
): ApiTransport {
  const host = new URL(session.hostUrl);
  return {
    credentials: "omit",
    resolveUrl(path) {
      const endpoint = new URL(path, `${host.origin}/`);
      if (endpoint.origin !== host.origin) {
        throw new Error(
          "Yurucommu API endpoint must stay on the connected host.",
        );
      }
      return endpoint.toString();
    },
    getAuthHeaders() {
      return { authorization: `${session.tokenType} ${session.accessToken}` };
    },
  };
}

function withYurucommuMobileTransport<T>(
  session: MobileSession,
  createRequests: () => T,
): T {
  setYurucommuApiTransport(createYurucommuMobileTransport(session));
  try {
    return createRequests();
  } finally {
    clearYurucommuApiTransport();
  }
}

async function fetchMobileUnreadCount(
  request: MobileReadRequest,
): Promise<number> {
  const response = await request("/api/notifications/unread/count");
  await assertOk(response, "Failed to load unread notification count");
  const value: unknown = await response.json();
  if (
    !isRecord(value) ||
    typeof value.count !== "number" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  ) {
    throw new Error("Yurucommu unread-count response is invalid.");
  }
  return value.count;
}

async function fetchMobileTimeline(
  request: MobileReadRequest,
  selected: MobileSession,
): Promise<MobilePost[]> {
  // The published SDK's timeline helper substitutes [] for an absent posts
  // member. Validate the actual response before that fallback can hide it.
  const startedAt = performance.now();
  const response = await request("/api/timeline?limit=20");
  await assertOk(response, "Failed to load timeline");
  const value: unknown = await response.json();
  if (!isRecord(value) || !Array.isArray(value.posts)) {
    throw new Error("Yurucommu timeline response is invalid.");
  }
  return value.posts.map((post) =>
    recordMobilePostLikeRead(decodeMobilePost(post), selected, startedAt),
  );
}

async function fetchMobileCurrentActor(
  request: MobileReadRequest,
): Promise<MobileActor> {
  const response = await request("/api/auth/me");
  if (response.status === 401 || response.status === 403) {
    throw new Error("Yurucommu session is no longer authorized.");
  }
  await assertOk(response, "Failed to load current user");
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw new Error("Yurucommu current-user response is invalid.");
  }
  return decodeMobileActor(value.actor);
}

function decodeMobileActor(value: unknown): MobileActor {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.ap_id) ||
    !nonEmptyString(value.preferred_username) ||
    !nullableString(value.name) ||
    !nullableString(value.icon_url)
  ) {
    throw new Error("Yurucommu current-user response is invalid.");
  }
  return value as unknown as MobileActor;
}

function decodeMobilePost(value: unknown): MobilePost {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.ap_id) ||
    typeof value.content !== "string" ||
    !nullableString(value.published) ||
    !nonNegativeInteger(value.like_count) ||
    !nonNegativeInteger(value.reply_count) ||
    !isRecord(value.author) ||
    !nonEmptyString(value.author.ap_id) ||
    !nullableString(value.author.preferred_username) ||
    (value.author.username !== undefined &&
      !nullableString(value.author.username)) ||
    !nullableString(value.author.name) ||
    !nullableString(value.author.icon_url)
  ) {
    throw new Error("Yurucommu post response is invalid.");
  }
  // Feed and bookmarks expose the same raw producer shape. Use the public
  // SDK's actor normalization consistently, including remote cached authors
  // whose preferred username is null, without inventing a missing timestamp.
  return {
    ...value,
    likeState:
      typeof value.liked === "boolean" && Number.isSafeInteger(value.like_count)
        ? value.liked
        : null,
    author: normalizeActor(value.author as unknown as MobileActor),
  } as unknown as MobilePost;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function registerPush(
  input: MobilePushRegistrationCallbackInput,
): Promise<void> {
  // The connected host owns the gateway allowlist and one binary talks to many
  // self-hosted servers, so the build-time URL is only a fallback: mobile-kit
  // asks the host first and throws a named error when neither side has one.
  const gateway =
    normalizeNotificationPusherGatewayUrl(
      import.meta.env.VITE_YURUCOMMU_NOTIFICATION_PUSHER_GATEWAY_URL,
    ) ?? "";
  const provider = input.registration.provider;
  if (provider !== "apns" && provider !== "fcm")
    throw new Error("Unsupported push provider.");
  await registerNotificationPusherWithHost({
    session: input.session,
    pusher: {
      kind: "http",
      app_id: "com.yurucommu",
      app_display_name: "Yurucommu",
      pushkey: input.registration.token,
      data: {
        url: gateway,
        format: "event_id_only",
        provider,
        environment: input.registration.environment ?? "production",
      },
    },
  });
}

export async function unregisterPush(
  input: MobilePushRegistrationCallbackInput,
): Promise<void> {
  await unregisterNotificationPusherWithHost({
    session: input.session,
    appId: "com.yurucommu",
    pushkey: input.registration.token,
  });
}
