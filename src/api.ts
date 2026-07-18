import {
  createMobileApiClient,
  normalizeNotificationPusherGatewayUrl,
  registerNotificationPusherWithHost,
  unregisterNotificationPusherWithHost,
  type MobilePushRegistrationCallbackInput,
  type MobileSession,
} from "@takosjp/mobile-kit";

export interface MobileActor {
  ap_id: string;
  preferred_username: string;
  name: string | null;
  icon_url: string | null;
}

export interface MobilePost {
  ap_id: string;
  content: string;
  published: string;
  like_count: number;
  reply_count: number;
  author: MobileActor;
}

export interface YurucommuMobileHome {
  actor: MobileActor;
  posts: MobilePost[];
  unread: number;
}

export async function loadHome(
  session: MobileSession,
): Promise<YurucommuMobileHome> {
  const api = createMobileApiClient({ session });
  const [me, timeline, notifications] = await Promise.all([
    api.json<{ actor: MobileActor }>(
      session.productEndpoints?.currentUser ?? "/api/auth/me",
    ),
    api.json<{ posts?: MobilePost[] }>("/api/timeline?limit=20"),
    api.json<{ notifications?: Array<{ read?: boolean }> }>(
      "/api/notifications?limit=30",
    ),
  ]);
  return {
    actor: me.actor,
    posts: timeline.posts ?? [],
    unread: (notifications.notifications ?? []).filter((item) => !item.read)
      .length,
  };
}

export async function createPost(
  session: MobileSession,
  content: string,
  visibility: "public" | "unlisted" | "followers" = "public",
): Promise<void> {
  await createMobileApiClient({ session }).json("/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, visibility }),
  });
}

export async function loadYurucommuMobileBookmarksPage(
  session: MobileSession,
): Promise<MobilePost[]> {
  const page = await createMobileApiClient({ session }).json<{
    posts?: MobilePost[];
  }>("/api/posts/bookmarks?limit=8");
  return page.posts ?? [];
}

export async function registerPush(
  input: MobilePushRegistrationCallbackInput,
): Promise<void> {
  const gateway = normalizeNotificationPusherGatewayUrl(
    import.meta.env.VITE_YURUCOMMU_NOTIFICATION_PUSHER_GATEWAY_URL,
  );
  if (!gateway)
    throw new Error("Yurucommu notification gateway is not configured.");
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
