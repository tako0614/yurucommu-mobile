import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import * as api from "../src/api.ts";
import { createFeedTimelineController } from "../src/feed-timeline-controller.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const host = "https://timeline.fixture.test";
const session: MobileSession = { hostUrl: host, product: "yurucommu", accessToken: "synthetic-timeline-only", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" };
const actor = { ap_id: host + "/ap/users/owner", preferred_username: "owner", username: "owner", name: null, icon_url: null };
const post = (id: string, content = id) => ({ ap_id: host + "/ap/posts/" + id, type: "Note", content, published: "2026-11-05T00:00:00Z", summary: null, edited_at: null, attachments: [], author: actor, like_count: 0, reply_count: 0, liked: false });
const cursor = "2026-11-05T00:00:00Z\u0000" + post("a+&?日本").ap_id;
const calls: Array<{ path: string; before: string | null; signal?: AbortSignal | null }> = [];
function wire(timeline: (before: string | null, signal?: AbortSignal | null) => Response | Promise<Response>) {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== host) throw Error("External request refused");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-timeline-only");
    calls.push({ path: url.pathname, before: url.searchParams.get("before"), signal: init?.signal });
    if (url.pathname === "/api/auth/me") return Response.json({ actor });
    if (url.pathname === "/api/notifications/unread/count") return Response.json({ count: 0 });
    expect(url.pathname).toBe("/api/timeline");
    expect(url.searchParams.get("limit")).toBe("20");
    return timeline(url.searchParams.get("before"), init?.signal);
  }) as typeof fetch;
}

test("home retains the actual producer's opaque continuation instead of discarding it", async () => {
  wire(() => Response.json({ posts: [post("a")], has_more: true, next_cursor: cursor }));
  const home = await api.loadHome(session);
  expect(home).toMatchObject({ posts: [post("a")], timeline: { hasMore: true, nextCursor: cursor } });
});

test("the actual page reader roundtrips the complete same-timestamp cursor", async () => {
  wire(before => { expect(before).toBe(cursor); return Response.json({ posts: [post("b")], has_more: false, next_cursor: null }); });
  const page = await api.loadMobileTimelinePage(session, cursor);
  expect(page).toMatchObject({ posts: [post("b")], hasMore: false, nextCursor: null });
});

test("legacy first pages remain readable without claiming their continuation is known", async () => {
  wire(() => Response.json({ posts: [post("a")] }));
  const home = await api.loadHome(session);
  const c = createFeedTimelineController({ session, home });
  try {
    expect(c.getState()).toMatchObject({ continuationKnown: false, hasMore: false, canLoadMore: false });
    expect(c.getState().posts.map(p => p.ap_id)).toEqual([post("a").ap_id]);
    await c.loadMore();
    expect(calls.filter(c => c.path === "/api/timeline")).toHaveLength(1);
    await expect(api.loadMobileTimelinePage(session, cursor)).rejects.toThrow("続き情報");
  } finally { c.dispose(); }
});

test("partial or inconsistent continuation metadata is rejected", async () => {
  for (const metadata of [{ has_more: true }, { next_cursor: cursor }, { has_more: "true", next_cursor: cursor }, { has_more: false, next_cursor: cursor }, { has_more: true, next_cursor: " " }]) {
    wire(() => Response.json({ posts: [post("a")], ...metadata }));
    await expect(api.loadMobileTimelinePage(session, cursor)).rejects.toThrow("続き情報");
  }
});

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function initial() { return api.loadHome(session); }
const first = () => Response.json({ posts: [post("a", "Current first page")], has_more: true, next_cursor: cursor });
const nextCursor = cursor + "-next";

test("manual continuation deduplicates a boundary row and keeps the current first-page value", async () => {
  wire(before => before === null ? first() : Response.json({ posts: [post("a", "Stale boundary"), post("b")], has_more: false, next_cursor: null }));
  const c = createFeedTimelineController({ session, home: await initial() });
  try {
    await c.loadMore();
    expect(c.getState().posts.map(p => p.content)).toEqual(["Current first page", "b"]);
    expect(c.getState()).toMatchObject({ hasMore: false, canLoadMore: false, error: "" });
    expect(api.mobilePostLikeReadStartedAt(c.getState().posts[1], session)).not.toBeNull();
  } finally { c.dispose(); }
});

test("a failed page retains rows and retries only the same opaque cursor on explicit request", async () => {
  let attempts = 0;
  wire(before => before === null ? first() : ++attempts === 1 ? Response.json({ error: "fixture unavailable" }, { status: 503 }) : Response.json({ posts: [post("b")], has_more: false, next_cursor: null }));
  const c = createFeedTimelineController({ session, home: await initial() });
  try {
    await c.loadMore();
    expect(c.getState().posts).toHaveLength(1);
    expect(c.getState().error).not.toBe("");
    expect(attempts).toBe(1);
    await c.loadMore();
    expect(c.getState().posts).toHaveLength(2);
    expect(c.getState().error).toBe("");
    expect(calls.filter(c => c.before !== null).map(c => c.before)).toEqual([cursor, cursor]);
  } finally { c.dispose(); }
});

test("one pending page is canceled by a newer first-page read and cannot append afterward", async () => {
  const held = gate<Response>(); let oldSignal: AbortSignal | null | undefined;
  let refreshed = false;
  wire((before, signal) => { if (before !== null) { oldSignal = signal; return held.promise; } return refreshed ? Response.json({ posts: [post("fresh")], has_more: false, next_cursor: null }) : first(); });
  const c = createFeedTimelineController({ session, home: await initial() });
  let reading: Promise<void> | undefined;
  try {
    reading = c.loadMore();await c.loadMore();
    expect(calls.filter(c => c.before !== null)).toHaveLength(1);
    refreshed = true;c.updateHome(session, await initial());
    expect(oldSignal?.aborted).toBe(true);
    held.resolve(Response.json({ posts: [post("old-late")], has_more: false, next_cursor: null }));await reading;
    expect(c.getState().posts.map(p => p.content)).toEqual(["fresh"]);
    expect(c.getState().error).toBe("");
  } finally { held.resolve(Response.json({ posts: [], has_more: false, next_cursor: null }));await reading;c.dispose(); }
});

test("session or endpoint retirement clears old pages and fences a late response", async () => {
  for (const change of [{ accessToken: "synthetic-replacement" }, { apiBaseUrl: "https://next.fixture.test" }]) {
    const held = gate<Response>();let signal: AbortSignal | null | undefined;
    wire((before, currentSignal) => { if (before === null) return first();signal = currentSignal;return held.promise; });
    const c = createFeedTimelineController({ session, home: await initial() });
    const reading = c.loadMore();
    try {
      c.updateHome({ ...session, ...change });
      expect(signal?.aborted).toBe(true);
      held.resolve(Response.json({ posts: [post("late")], has_more: false, next_cursor: null }));await reading;
      expect(c.getState().posts).toEqual([]);
      expect(c.getState().error).toBe("");
    } finally { held.resolve(Response.json({ posts: [], has_more: false, next_cursor: null }));await reading;c.dispose(); }
  }
});

test("an empty advancing page stays manual and a cursor cycle never appends its rows", async () => {
  let count = 0;
  wire(before => before === null ? first() : ++count === 1 ? Response.json({ posts: [], has_more: true, next_cursor: nextCursor }) : Response.json({ posts: [post("cycle")], has_more: true, next_cursor: cursor }));
  const c = createFeedTimelineController({ session, home: await initial() });
  try {
    await c.loadMore();expect(count).toBe(1);expect(c.getState().hasMore).toBe(true);
    await c.loadMore();expect(count).toBe(2);
    expect(c.getState().posts.map(p => p.content)).toEqual(["Current first page"]);
    expect(c.getState().error).toContain("続き位置");
  } finally { c.dispose(); }
});

test("cache projections retain older pages while removing confirmed deletions and adopting actual edit receipts", async () => {
  wire(before => before === null ? first() : Response.json({ posts: [post("b")], has_more: false, next_cursor: null }));
  const home = await initial(), removed = new Set<string>();
  const { createPostEditStore } = await import("../src/post-edit-store.ts");
  const { loadMobileEditablePost, saveMobilePostEdit } = await import("../src/post-edit-api.ts");
  const edits = createPostEditStore({ session });
  const c = createFeedTimelineController({ session, home, projectPosts: rows => rows.filter(p => !removed.has(p.ap_id)).map(p => edits.project(p)) });
  try {
    await c.loadMore();
    const fetchWire = globalThis.fetch;let content = "b";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/posts/" + encodeURIComponent(post("b").ap_id)) {
        if (init?.method === "PATCH") { content = JSON.parse(String(init.body)).content;return Response.json({ success: true, post: { ap_id: post("b").ap_id, content, summary: null } }); }
        return Response.json({ post: post("b", content) });
      }
      return fetchWire(input, init);
    }) as typeof fetch;
    const before = await loadMobileEditablePost(session, post("b").ap_id, actor.ap_id);
    const receipt = await saveMobilePostEdit(session, before, { content: "Confirmed edit" });
    expect(edits.record(receipt)).toBe(true);
    removed.add(post("a").ap_id);
    c.updateHome(session, { ...home, posts: [...home.posts] });
    expect(c.getState().posts.map(p => p.content)).toEqual(["Confirmed edit"]);
  } finally { c.dispose();edits.clear(); }
});

test("pausing the actual HTTP page aborts a JSON body after headers and preserves a manual retry", async () => {
  const headers = gate<void>(), aborted = gate<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, fetch(request) {
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"posts":')); } }), { headers: { "content-type": "application/json" } });
  } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { const response = await originalFetch(input, init);headers.resolve();return response; }) as typeof fetch;
  const current = { ...session, hostUrl: server.url.origin };
  const c = createFeedTimelineController({ session: current, home: { actor, posts: [post("a")], unread: 0, timeline: { hasMore: true, nextCursor: cursor } } });
  const reading = c.loadMore();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await headers.promise;c.pause();await reading;
    expect(c.getState()).toMatchObject({ loading: false, hasMore: true, canLoadMore: true });
    expect(c.getState().posts).toHaveLength(1);
    const ended = await Promise.race([aborted.promise.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), 1000); })]);
    expect(ended).toBe(true);
  } finally { if (timer) clearTimeout(timer);c.dispose();server.stop(true); }
});
