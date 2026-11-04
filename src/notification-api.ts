import type { MobileSession } from "@takosjp/mobile-kit";
import { snapshotFeedSession } from "./feed-session.ts";
import {
  assertOk,
  normalizeNotification,
  normalizePost,
  type Notification,
  type Post,
} from "@takosjp/yurucommu-api";
import {
  withMobileReadScope,
  recordMobilePostLikeRead,
  type MobilePostVisibility,
} from "./api.ts";

export interface MobileNotificationsPage {
  readonly notifications: readonly Notification[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

// The product wire contract permits an explicitly unknown publication date.
// Keep the normalized SDK fields, without inventing that date from created_at.
export type MobileNotificationPost = Omit<Post, "published"> & {
  readonly published: string | null;
  // Normalization supplies false for a missing flag; that is insufficient
  // authority for a mutation. Preserve unknown state for the native action.
  readonly bookmarkState: boolean | null;
  readonly likeState: boolean | null;
  readonly replyContext: Readonly<{
    visibility: MobilePostVisibility;
    communityApId: string | null;
  }> | null;
};

export async function loadMobileNotifications(
  session: MobileSession,
  before?: string,
  signal?: AbortSignal,
): Promise<MobileNotificationsPage> {
  const query = new URLSearchParams({ limit: "20" });
  if (before !== undefined) {
    if (!before.trim()) throw new Error("通知の続きの位置が不正です。");
    query.set("before", before);
  }
  return withMobileReadScope(session, signal, async (request) => {
    const response = await request(`/api/notifications?${query}`);
    await assertOk(response, "通知を読み込めませんでした。");
    const value: unknown = await response.json();
    if (
      !record(value) ||
      !Array.isArray(value.notifications) ||
      typeof value.has_more !== "boolean" ||
      (value.next_cursor !== null &&
        value.next_cursor !== undefined &&
        !nonEmpty(value.next_cursor)) ||
      (value.has_more && !nonEmpty(value.next_cursor))
    ) {
      throw new Error("通知一覧の応答を確認できませんでした。");
    }
    return {
      notifications: value.notifications.map(decodeNotification),
      hasMore: value.has_more,
      nextCursor: (value.next_cursor as string | null | undefined) ?? null,
    };
  });
}

export async function loadMobileNotificationPost(
  session: MobileSession,
  apId: string,
  signal?: AbortSignal,
): Promise<MobileNotificationPost> {
  if (!nonEmpty(apId)) throw new Error("投稿の識別子が不正です。");
  // Even a remote AP ID is looked up through the connected server. Never send
  // its native bearer directly to the object's origin.
  const selected = snapshotFeedSession(session);
  return withMobileReadScope(selected, signal, async (request) => {
    const startedAt = performance.now();
    const response = await request(`/api/posts/${encodeURIComponent(apId)}`);
    await assertOk(response, "投稿を読み込めませんでした。");
    const value: unknown = await response.json();
    if (!record(value) || !record(value.post) || value.post.ap_id !== apId) {
      throw new Error("投稿の応答を確認できませんでした。");
    }
    return recordMobilePostLikeRead(
      decodePost(value.post),
      selected,
      startedAt,
    );
  });
}

export interface MobileRepliesPage {
  readonly replies: readonly MobileNotificationPost[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export async function loadMobilePostReplies(
  session: MobileSession,
  parentId: string,
  before?: string,
  signal?: AbortSignal,
): Promise<MobileRepliesPage> {
  if (!nonEmpty(parentId) || (before !== undefined && !nonEmpty(before)))
    throw new Error("返信先または続きの位置が不正です。");
  const query = new URLSearchParams({ limit: "20" });
  if (before !== undefined) query.set("before", before);
  const selected = snapshotFeedSession(session);
  return withMobileReadScope(selected, signal, async (request) => {
    const startedAt = performance.now();
    const response = await request(
      `/api/posts/${encodeURIComponent(parentId)}/replies?${query}`,
    );
    await assertOk(response, "返信を読み込めませんでした。");
    const value: unknown = await response.json();
    if (
      !record(value) ||
      !Array.isArray(value.replies) ||
      typeof value.has_more !== "boolean" ||
      (value.next_cursor !== null &&
        value.next_cursor !== undefined &&
        !nonEmpty(value.next_cursor)) ||
      (value.has_more && !nonEmpty(value.next_cursor))
    )
      throw new Error("返信一覧の応答を確認できませんでした。");
    return {
      replies: value.replies.map((reply) => {
        if (!record(reply) || reply.in_reply_to !== parentId)
          throw new Error("返信先が一致しない応答を受け取りました。");
        return recordMobilePostLikeRead(decodePost(reply), selected, startedAt);
      }),
      hasMore: value.has_more,
      nextCursor: (value.next_cursor as string | null | undefined) ?? null,
    };
  });
}

function decodePost(value: unknown): MobileNotificationPost {
  if (
    !record(value) ||
    !nonEmpty(value.ap_id) ||
    typeof value.content !== "string" ||
    !nullableString(value.published) ||
    !validActor(value.author)
  )
    throw new Error("投稿の応答を確認できませんでした。");
  const visibility = value.visibility;
  return {
    ...normalizePost(value as unknown as Post),
    published: value.published,
    likeState:
      typeof value.liked === "boolean" &&
      Number.isSafeInteger(value.like_count) &&
      Number(value.like_count) >= 0
        ? value.liked
        : null,
    bookmarkState:
      typeof value.bookmarked === "boolean" ? value.bookmarked : null,
    replyContext:
      value.type === "Note" &&
      (visibility === "public" ||
        visibility === "unlisted" ||
        visibility === "followers" ||
        visibility === "direct") &&
      (value.community_ap_id === null || nonEmpty(value.community_ap_id))
        ? { visibility, communityApId: value.community_ap_id as string | null }
        : null,
  };
}

function decodeNotification(value: unknown): Notification {
  if (
    !record(value) ||
    !nonEmpty(value.id) ||
    !nonEmpty(value.type) ||
    !validActor(value.actor) ||
    typeof value.read !== "boolean" ||
    typeof value.created_at !== "string" ||
    (value.object_ap_id !== null &&
      value.object_ap_id !== undefined &&
      !nonEmpty(value.object_ap_id)) ||
    (value.target_kind !== undefined &&
      !["post", "story", "profile", "notifications"].includes(
        String(value.target_kind),
      )) ||
    (value.target_id !== null &&
      value.target_id !== undefined &&
      !nonEmpty(value.target_id))
  ) {
    throw new Error("通知の応答を確認できませんでした。");
  }
  // Reuse the public wire compatibility rules, including legacy targets.
  // Navigation consumes target_kind/target_id, never a raw target_url.
  return normalizeNotification(value as unknown as Notification);
}

function validActor(value: unknown): boolean {
  return (
    record(value) &&
    nonEmpty(value.ap_id) &&
    nullableString(value.preferred_username) &&
    (value.username === undefined || nullableString(value.username)) &&
    nullableString(value.name) &&
    nullableString(value.icon_url)
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
