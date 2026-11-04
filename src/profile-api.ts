import type { MobileSession } from "@takosjp/mobile-kit";
import { snapshotFeedSession } from "./feed-session.ts";
import {
  withMobileReadScope,
  readMobileResponseJson,
  recordMobilePostLikeRead,
} from "./api.ts";
import {
  decodeMobileNotificationPost,
  type MobileNotificationPost,
} from "./notification-api.ts";

export interface MobileProfile {
  readonly ap_id: string;
  readonly preferred_username: string | null;
  readonly username: string | null;
  readonly name: string | null;
  readonly summary: string | null;
  readonly icon_url: string | null;
  readonly header_url: string | null;
  readonly follower_count: number | null;
  readonly following_count: number | null;
  readonly post_count: number | null;
  readonly is_private: boolean | null;
  readonly fields: readonly { name: string; value: string }[];
  readonly moved_to: string | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nullable = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
export function validMobileActorApId(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 4096
  )
    return false;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !!url.host &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function metric(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw Error("プロフィールの件数を確認できませんでした。");
  return value;
}
function profile(value: unknown): MobileProfile {
  if (
    !record(value) ||
    typeof value.ap_id !== "string" ||
    !validMobileActorApId(value.ap_id) ||
    !nullable(value.preferred_username) ||
    !nullable(value.name) ||
    !nullable(value.summary) ||
    !nullable(value.icon_url) ||
    !(value.header_url === undefined || nullable(value.header_url)) ||
    !(value.username === undefined || nullable(value.username))
  )
    throw Error("プロフィールの応答を確認できませんでした。");
  const fields = value.fields ?? [];
  if (
    !Array.isArray(fields) ||
    fields.some(
      (f) =>
        !record(f) || typeof f.name !== "string" || typeof f.value !== "string",
    )
  )
    throw Error("プロフィールの項目を確認できませんでした。");
  const privateValue = value.is_private;
  if (
    privateValue !== undefined &&
    privateValue !== null &&
    privateValue !== 0 &&
    privateValue !== 1 &&
    typeof privateValue !== "boolean"
  )
    throw Error("プロフィールの公開設定を確認できませんでした。");
  const moved = value.moved_to ?? null;
  if (
    moved !== null &&
    (typeof moved !== "string" || !validMobileActorApId(moved))
  )
    throw Error("プロフィールの移転先を確認できませんでした。");
  return {
    ap_id: value.ap_id,
    preferred_username: value.preferred_username,
    name: value.name,
    summary: value.summary,
    icon_url: value.icon_url,
    header_url: (value.header_url ?? null) as string | null,
    username: (value.username ?? null) as string | null,
    follower_count: metric(value.follower_count),
    following_count: metric(value.following_count),
    post_count: metric(value.post_count),
    is_private:
      privateValue === undefined || privateValue === null
        ? null
        : !!privateValue,
    fields: fields as { name: string; value: string }[],
    moved_to: moved,
  };
}
function selectedIdentifier(identifier: string | null) {
  if (identifier === null)
    return { lookup: null, apId: null, username: null, host: null };
  if (validMobileActorApId(identifier))
    return { lookup: identifier, apId: identifier, username: null, host: null };
  if (identifier !== identifier.trim() || identifier.length > 512)
    throw Error("プロフィールの識別子が不正です。");
  const match = /^@?([A-Za-z0-9_]+)(?:@([A-Za-z0-9.-]+))?$/.exec(identifier);
  if (!match) throw Error("プロフィールの識別子が不正です。");
  return {
    lookup: match[2] ? `${match[1]}@${match[2].toLowerCase()}` : match[1]!,
    apId: null,
    username: match[1]!,
    host: match[2]?.toLowerCase() ?? null,
  };
}
export async function loadMobileProfile(
  session: MobileSession,
  identifier: string | null,
  signal?: AbortSignal,
): Promise<MobileProfile> {
  const input = selectedIdentifier(identifier),
    selected = snapshotFeedSession(session);
  return withMobileReadScope(selected, signal, async (request) => {
    let lookup = input.lookup;
    if (lookup === null) {
      const me = await request("/api/auth/me");
      if (!me.ok) throw Error(`本人を確認できませんでした（${me.status}）。`);
      const value = await readMobileResponseJson(me, 128 * 1024, "本人確認");
      if (
        !record(value) ||
        !record(value.actor) ||
        typeof value.actor.ap_id !== "string" ||
        !validMobileActorApId(value.actor.ap_id)
      )
        throw Error("本人の応答を確認できませんでした。");
      lookup = value.actor.ap_id;
      input.apId = lookup;
    }
    const response = await request(`/api/actors/${encodeURIComponent(lookup)}`);
    if (!response.ok)
      throw Error(`プロフィールを読み込めませんでした（${response.status}）。`);
    const value = await readMobileResponseJson(
      response,
      256 * 1024,
      "プロフィール",
    );
    if (!record(value)) throw Error("プロフィールの応答が不正です。");
    const actor = profile(value.actor);
    if (
      (input.apId !== null && actor.ap_id !== input.apId) ||
      (input.username !== null &&
        actor.preferred_username !== input.username) ||
      (input.host !== null &&
        new URL(actor.ap_id).host.toLowerCase() !== input.host)
    )
      throw Error("プロフィールの本人識別子が一致しません。");
    return actor;
  });
}
export interface MobileProfilePosts {
  readonly posts: readonly MobileNotificationPost[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}
export async function loadMobileProfilePosts(
  session: MobileSession,
  actorId: string,
  before?: string,
  signal?: AbortSignal,
): Promise<MobileProfilePosts> {
  if (
    !validMobileActorApId(actorId) ||
    (before !== undefined && !before.trim())
  )
    throw Error("プロフィールの投稿位置が不正です。");
  const selected = snapshotFeedSession(session),
    query = new URLSearchParams({ limit: "20" });
  if (before !== undefined) query.set("before", before);
  return withMobileReadScope(selected, signal, async (request) => {
    const startedAt = performance.now(),
      response = await request(
        `/api/actors/${encodeURIComponent(actorId)}/posts?${query}`,
      );
    if (!response.ok)
      throw Error(`投稿を読み込めませんでした（${response.status}）。`);
    const value = await readMobileResponseJson(
      response,
      1024 * 1024,
      "プロフィールの投稿",
    );
    if (
      !record(value) ||
      !Array.isArray(value.posts) ||
      typeof value.has_more !== "boolean" ||
      !(
        value.next_cursor === undefined ||
        value.next_cursor === null ||
        (typeof value.next_cursor === "string" && !!value.next_cursor.trim())
      ) ||
      (value.has_more &&
        !(typeof value.next_cursor === "string" && value.next_cursor.trim()))
    )
      throw Error("プロフィールの投稿一覧を確認できませんでした。");
    const posts = value.posts.map((raw) => {
      if (!record(raw) || raw.type !== "Note" || raw.in_reply_to !== null)
        throw Error("プロフィールの投稿種別が不正です。");
      const post = decodeMobileNotificationPost(raw);
      if (post.author.ap_id !== actorId)
        throw Error("プロフィールの投稿者または投稿種別が一致しません。");
      return recordMobilePostLikeRead(post, selected, startedAt);
    });
    return {
      posts,
      hasMore: value.has_more,
      nextCursor: (value.next_cursor as string | null | undefined) ?? null,
    };
  });
}
