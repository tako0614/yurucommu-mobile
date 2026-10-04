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
} from "@takosjp/yurucommu-api";

export type MobileActor = Pick<
  Actor,
  "ap_id" | "preferred_username" | "name" | "icon_url"
>;

export type MobilePost = Pick<
  Post,
  | "ap_id"
  | "content"
  | "like_count"
  | "reply_count"
  | "author"
> & { published: string | null };

export interface YurucommuMobileHome {
  actor: MobileActor;
  posts: MobilePost[];
  unread: number;
}

export async function loadHome(
  session: MobileSession,
): Promise<YurucommuMobileHome> {
  const requests = withYurucommuMobileTransport(session, () => [
    fetchMobileCurrentActor(),
    fetchMobileTimeline(),
    fetchMobileUnreadCount(),
  ] as const);
  const [actor, timeline, unread] = await Promise.all(requests);
  return {
    actor,
    posts: timeline,
    unread,
  };
}

export async function createPost(
  session: MobileSession,
  content: string,
  visibility: "public" | "unlisted" | "followers" = "public",
): Promise<void> {
  const post: unknown = await withYurucommuMobileTransport(session, () =>
    createYurucommuPost({ content, visibility }),
  );
  if (!isRecord(post) || !nonEmptyString(post.ap_id)) {
    throw new Error(
      "投稿の結果を確認できませんでした。再送する前にフィードを確認してください。",
    );
  }
}

export async function loadYurucommuMobileBookmarksPage(
  session: MobileSession,
): Promise<MobilePost[]> {
  const response = await withYurucommuMobileTransport(session, () =>
    apiFetch("/api/bookmarks?limit=8"),
  );
  await assertOk(response, "Failed to load bookmarks");
  const value: unknown = await response.json();
  if (!isRecord(value) || !Array.isArray(value.posts)) {
    throw new Error("Yurucommu bookmarks response is invalid.");
  }
  return value.posts.map(decodeMobilePost);
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
        throw new Error("Yurucommu API endpoint must stay on the connected host.");
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

async function fetchMobileUnreadCount(): Promise<number> {
  const response = await apiFetch("/api/notifications/unread/count");
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

async function fetchMobileTimeline(): Promise<MobilePost[]> {
  // The published SDK's timeline helper substitutes [] for an absent posts
  // member. Validate the actual response before that fallback can hide it.
  const response = await apiFetch("/api/timeline?limit=20");
  await assertOk(response, "Failed to load timeline");
  const value: unknown = await response.json();
  if (!isRecord(value) || !Array.isArray(value.posts)) {
    throw new Error("Yurucommu timeline response is invalid.");
  }
  return value.posts.map(decodeMobilePost);
}

async function fetchMobileCurrentActor(): Promise<MobileActor> {
  const response = await apiFetch("/api/auth/me");
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
    (value.author.username !== undefined && !nullableString(value.author.username)) ||
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
