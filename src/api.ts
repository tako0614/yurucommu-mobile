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
  fetchCurrentActor,
  fetchTimeline,
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
  | "published"
  | "like_count"
  | "reply_count"
  | "author"
>;

export interface YurucommuMobileHome {
  actor: MobileActor;
  posts: MobilePost[];
  unread: number;
}

export async function loadHome(
  session: MobileSession,
): Promise<YurucommuMobileHome> {
  const requests = withYurucommuMobileTransport(session, () => [
    fetchCurrentActor(),
    fetchTimeline({ limit: 20 }),
    fetchMobileUnreadCount(),
  ] as const);
  const [actor, timeline, unread] = await Promise.all(requests);
  if (!actor) throw new Error("Yurucommu session is no longer authorized.");
  return {
    actor,
    posts: timeline.posts.map(decodeMobilePost),
    unread,
  };
}

export async function createPost(
  session: MobileSession,
  content: string,
  visibility: "public" | "unlisted" | "followers" = "public",
): Promise<void> {
  await withYurucommuMobileTransport(session, () =>
    createYurucommuPost({ content, visibility }),
  );
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

function decodeMobilePost(value: unknown): MobilePost {
  if (
    !isRecord(value) ||
    typeof value.ap_id !== "string" ||
    typeof value.content !== "string" ||
    typeof value.published !== "string" ||
    typeof value.like_count !== "number" ||
    typeof value.reply_count !== "number" ||
    !isRecord(value.author) ||
    typeof value.author.ap_id !== "string" ||
    typeof value.author.preferred_username !== "string" ||
    (value.author.name !== null && typeof value.author.name !== "string") ||
    (value.author.icon_url !== null &&
      typeof value.author.icon_url !== "string")
  ) {
    throw new Error("Yurucommu post response is invalid.");
  }
  return value as unknown as MobilePost;
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
