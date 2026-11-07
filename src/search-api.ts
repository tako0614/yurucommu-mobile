import type { MobileSession } from "@takosjp/mobile-kit";
import { normalizeActor, type Actor } from "@takosjp/yurucommu-api";
import { readMobileResponseJson, withMobileReadScope } from "./api.ts";
import { snapshotFeedSession } from "./feed-session.ts";
import {
  decodeMobileNotificationPost,
  type MobileNotificationPost,
} from "./notification-api.ts";
import { validMobileActorApId } from "./profile-api.ts";

export type MobileSearchKind = "posts" | "actors";
export type MobileSearchSelection = MobileSearchKind | "auto";
export type MobileSearchActor = Pick<
  Actor,
  "ap_id" | "preferred_username" | "name" | "icon_url"
>;
export interface MobileSearchPage {
  readonly posts: readonly MobileNotificationPost[];
  readonly actors: readonly MobileSearchActor[];
  readonly hasMore: boolean;
  readonly nextOffset: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nullable = (value: unknown) => value === null || typeof value === "string";

/** A web link without a tab uses the same users-first selection as the web UI. */
export async function loadMobileSearchInitial(
  session: MobileSession,
  query: string,
  kind: MobileSearchSelection,
  signal?: AbortSignal,
): Promise<MobileSearchPage & { readonly kind: MobileSearchKind }> {
  if (kind !== "auto") return { ...await loadMobileSearch(session, query, kind, 0, signal), kind };
  if (!query.trim() || query.trim() === "#") throw Error("検索語を確認してください。");
  const selected = snapshotFeedSession(session), owned = new AbortController();
  const cancel = () => owned.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const [actors, posts] = await Promise.all([
      loadMobileSearch(selected, query, "actors", 0, owned.signal),
      loadMobileSearch(selected, query, "posts", 0, owned.signal),
    ]);
    return actors.actors.length ? { ...actors, kind: "actors" } : { ...posts, kind: "posts" };
  } finally {
    owned.abort();
    signal?.removeEventListener("abort", cancel);
  }
}

/** Use the selected host's existing search routes, never a result's origin. */
export async function loadMobileSearch(
  session: MobileSession,
  query: string,
  kind: MobileSearchKind,
  offset = 0,
  signal?: AbortSignal,
): Promise<MobileSearchPage> {
  const term = query.trim();
  if (
    !term ||
    (kind !== "posts" && kind !== "actors") ||
    !Number.isSafeInteger(offset) || offset < 0 || offset > 10000 ||
    (kind === "posts" && term === "#")
  ) throw Error("検索語または続きの位置を確認してください。");
  const selected = snapshotFeedSession(session);
  return withMobileReadScope(selected, signal, async (request) => {
    const hashtag = kind === "posts" && term.startsWith("#");
    const params = new URLSearchParams({
      limit: "20", offset: String(offset),
      sort: kind === "actors" ? "relevance" : "recent",
    });
    if (!hashtag) params.set("q", term);
    const path = hashtag
      ? `/api/search/hashtag/${encodeURIComponent(term.slice(1))}`
      : `/api/search/${kind}`;
    const response = await request(`${path}?${params}`);
    if (!response.ok) throw Error(`検索できませんでした（${response.status}）。`);
    const value = await readMobileResponseJson(response, 2 * 1024 * 1024, "検索");
    if (!record(value) || !Array.isArray(value[kind]) ||
      typeof value.has_more !== "boolean" ||
      (value.offset !== undefined && value.offset !== offset))
      throw Error("検索結果の応答を確認できませんでした。");
    const rows = value[kind] as unknown[];
    if (rows.length > 20 || (value.has_more && !rows.length))
      throw Error("検索結果の続きの位置を確認できませんでした。");
    return {
      posts: kind === "posts" ? rows.map(decodeMobileNotificationPost) : [],
      actors: kind === "actors" ? rows.map((row) => {
        if (!record(row) || !validMobileActorApId(row.ap_id) ||
          !nullable(row.preferred_username) || !nullable(row.name) ||
          !nullable(row.icon_url) ||
          (row.username !== undefined && !nullable(row.username)))
          throw Error("検索したユーザーの応答を確認できませんでした。");
        return normalizeActor(row as unknown as Actor);
      }) : [],
      hasMore: value.has_more,
      // The server's offset counts raw returned rows, not deduplicated cards.
      nextOffset: offset + rows.length,
    };
  });
}
