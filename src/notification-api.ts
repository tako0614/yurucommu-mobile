import type { MobileSession } from "@takosjp/mobile-kit";
import {
  assertOk,
  normalizeNotification,
  normalizePost,
  type Notification,
  type Post,
} from "@takosjp/yurucommu-api";
import { withMobileReadScope } from "./api.ts";

export interface MobileNotificationsPage {
  readonly notifications: readonly Notification[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

// The product wire contract permits an explicitly unknown publication date.
// Keep the normalized SDK fields, without inventing that date from created_at.
export type MobileNotificationPost = Omit<Post, "published"> & {
  readonly published: string | null;
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
  return withMobileReadScope(session, signal, async (request) => {
    const response = await request(`/api/posts/${encodeURIComponent(apId)}`);
    await assertOk(response, "投稿を読み込めませんでした。");
    const value: unknown = await response.json();
    if (
      !record(value) ||
      !record(value.post) ||
      value.post.ap_id !== apId ||
      typeof value.post.content !== "string" ||
      !nullableString(value.post.published) ||
      !validActor(value.post.author)
    ) {
      throw new Error("投稿の応答を確認できませんでした。");
    }
    return {
      ...normalizePost(value.post as unknown as Post),
      published: value.post.published,
    };
  });
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
