import { afterEach, expect, test } from "bun:test";
import { loadMobileSearch, loadMobileSearchInitial } from "../src/search-api.ts";
import { createSearchController } from "../src/search-controller.ts";
import { createHostRouteHandoff } from "../src/host-route.ts";

const session = { product: "yurucommu" as const, hostUrl: "https://search.fixture.test",
  accessToken: "synthetic-search", tokenType: "Bearer", createdAt: "2026-11-07T00:00:00Z" };
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
afterEach(() => { globalThis.fetch = originalFetch; cleanups.splice(0).forEach(fn => fn()); });
const actor = (extra: Record<string, unknown> = {}) => ({
  ap_id: "https://other.fixture.test/users/alice", preferred_username: "alice", name: "Alice", icon_url: null, ...extra,
});
const post = (id = "https://other.fixture.test/posts/one", extra: Record<string, unknown> = {}) => ({
  ap_id: id, type: "Note", content: "<p>ねこ</p>", summary: null, attachments: [],
  published: null, like_count: 0, reply_count: 0, author: actor(), ...extra,
});
const page = (posts: unknown[] = [], has_more = false) => Response.json({ posts, has_more });
type Call = { url: string; init?: RequestInit; resolve: (response: Response) => void };
function fixture() {
  const calls: Call[] = [];
  // Ignore abort here deliberately: the controller must also fence late results.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => {
    calls.push({ url: String(input), init, resolve });
  })) as unknown as typeof fetch;
  return calls;
}
function controller() {
  const c = createSearchController({ session }); cleanups.push(() => c.dispose()); c.open(); return c;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check() && Date.now() < deadline) await Bun.sleep(1);
  expect(check()).toBe(true);
}

test("existing post search encodes the query, uses only the selected origin and preserves unknown state", async () => {
  const calls = fixture(), pending = loadMobileSearch(session, "  ねこ & +  ", "posts");
  const url = new URL(calls[0]!.url);
  expect(url.origin).toBe(session.hostUrl); expect(url.pathname).toBe("/api/search/posts");
  expect(url.searchParams.get("q")).toBe("ねこ & +"); expect(url.searchParams.get("sort")).toBe("recent");
  expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer synthetic-search");
  expect(calls[0]!.init?.credentials).toBe("omit"); expect(calls[0]!.init?.redirect).toBe("error");
  calls[0]!.resolve(page([post()]));
  const value = await pending;
  expect(value.posts[0]!.published).toBeNull(); expect(value.posts[0]!.likeState).toBeNull();
  expect(value.posts[0]!.bookmarkState).toBeNull(); expect(value.nextOffset).toBe(1);
});
test("actor search uses the existing relevance and offset contract", async () => {
  const calls = fixture(), pending = loadMobileSearch(session, "alice", "actors", 2);
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe("/api/search/actors"); expect(url.searchParams.get("offset")).toBe("2");
  expect(url.searchParams.get("sort")).toBe("relevance");
  calls[0]!.resolve(Response.json({ actors: [actor()], offset: 2, has_more: true }));
  const value = await pending;
  expect(value.actors[0]!.ap_id).toBe(actor().ap_id); expect(value.nextOffset).toBe(3); expect(value.hasMore).toBe(true);
});
test("a tabless web query selects real actor results first and uses their pagination", async () => {
  const calls = fixture(), c = controller(); c.open("@alice", "auto");
  expect(calls.map(c => new URL(c.url).pathname)).toEqual(["/api/search/actors", "/api/search/posts"]);
  calls[0]!.resolve(Response.json({ actors: [actor()], has_more: true })); calls[1]!.resolve(page([post()]));
  await until(() => c.getState().loaded);
  expect(c.getState().resultKind).toBe("actors"); expect(c.getState().kind).toBe("actors");
  expect(c.getState().posts).toHaveLength(0); expect(c.getState().actors).toHaveLength(1);
  const more = c.loadMore(); expect(new URL(calls[2]!.url).pathname).toBe("/api/search/actors");
  expect(new URL(calls[2]!.url).searchParams.get("offset")).toBe("1");
  calls[2]!.resolve(Response.json({ actors: [], has_more: false })); await more;
});
test("tabless search uses posts only after a verified empty actor result and preserves a newer draft", async () => {
  const calls = fixture(), c = controller(); c.open("cats", "auto");
  c.setQuery("not submitted"); c.setKind("actors");
  calls[0]!.resolve(Response.json({ actors: [], has_more: false })); calls[1]!.resolve(page([post()]));
  await until(() => c.getState().loaded);
  expect(c.getState().resultKind).toBe("posts"); expect(c.getState().posts).toHaveLength(1);
  expect(c.getState().query).toBe("not submitted"); expect(c.getState().kind).toBe("actors");
});
test("a failed automatic search retries both original reads instead of retargeting new input", async () => {
  const calls = fixture(), c = controller(); c.open("@alice", "auto");
  calls[0]!.resolve(new Response("unavailable", { status: 503 })); calls[1]!.resolve(page([post()]));
  await until(() => c.getState().canRetry);
  expect(c.getState().loaded).toBe(false);
  c.setQuery("next draft"); c.setKind("posts"); const retry = c.retry();
  expect(calls.slice(2).map(c => new URL(c.url).searchParams.get("q"))).toEqual(["@alice", "@alice"]);
  calls[2]!.resolve(Response.json({ actors: [actor()], has_more: false })); calls[3]!.resolve(page()); await retry;
  expect(c.getState().resultKind).toBe("actors"); expect(c.getState().query).toBe("next draft");
  expect(c.getState().kind).toBe("posts");
});
test("an automatic search aborts its sibling's real HTTP body on failure", async () => {
  let reads = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    reads++;
    if (new URL(request.url).pathname.endsWith("/actors")) {
      await until(() => reads === 2);
      return new Response("not available", { status: 503 });
    }
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"posts":')); } }), { headers: { "content-type": "application/json" } });
  } }); cleanups.push(() => server.stop(true));
  await expect(loadMobileSearchInitial({ ...session, hostUrl: server.url.origin }, "cats", "auto")).rejects.toThrow("503");
  expect(reads).toBe(2);
});
test("tabless hashtag search uses exact-tag posts after the actual actor lookup is empty", async () => {
  const calls = fixture(), pending = loadMobileSearchInitial(session, "#cats", "auto");
  expect(new URL(calls[1]!.url).pathname).toBe("/api/search/hashtag/cats");
  calls[0]!.resolve(Response.json({ actors: [], has_more: false })); calls[1]!.resolve(page([post()]));
  expect((await pending).kind).toBe("posts");
});
test("hashtag searches use the exact-tag producer rather than content substring search", async () => {
  const calls = fixture(), pending = loadMobileSearch(session, "#ねこ", "posts");
  expect(new URL(calls[0]!.url).pathname).toBe("/api/search/hashtag/%E3%81%AD%E3%81%93");
  expect(new URL(calls[0]!.url).searchParams.has("q")).toBe(false);
  calls[0]!.resolve(page()); await pending;
});
test("empty input and invalid continuation do not make requests", async () => {
  const calls = fixture();
  for (const [query, offset] of [[" ", 0], ["#", 0], ["cats", -1], ["cats", 10001], ["cats", 0.5]] as const)
    await expect(loadMobileSearch(session, query, "posts", offset)).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
for (const [name, response] of [
  ["server refusal", () => new Response("denied", { status: 403 })],
  ["missing continuation", () => Response.json({ posts: [] })],
  ["invalid list", () => Response.json({ posts: {}, has_more: false })],
  ["nonadvancing page", () => page([], true)],
  ["wrong offset", () => Response.json({ posts: [post()], offset: 20, has_more: false })],
  ["oversized page", () => page(Array.from({ length: 21 }, () => post()))],
  ["invalid post", () => page([post(undefined, { content: null })])],
] as const) test(`${name} remains a recoverable error, never an empty success`, async () => {
  const calls = fixture(), c = controller(); c.setQuery("cats"); const pending = c.search();
  calls[0]!.resolve(response()); expect(await pending).toBe(false);
  expect(c.getState().loaded).toBe(false); expect(c.getState().error).not.toBe("");
});
test("invalid actor identity is rejected before navigation can consume it", async () => {
  const calls = fixture(), pending = loadMobileSearch(session, "alice", "actors");
  calls[0]!.resolve(Response.json({ actors: [actor({ ap_id: "javascript:bad" })], has_more: false }));
  await expect(pending).rejects.toThrow("ユーザー");
});
test("typing is local; an older query result does not overwrite newer input", async () => {
  const calls = fixture(), c = controller(); c.setQuery("first");
  expect(calls).toHaveLength(0); const pending = c.search(); c.setQuery("next draft"); c.setKind("actors");
  calls[0]!.resolve(page([post()])); expect(await pending).toBe(true);
  expect(c.getState().resultQuery).toBe("first"); expect(c.getState().resultKind).toBe("posts");
  expect(c.getState().query).toBe("next draft"); expect(c.getState().kind).toBe("actors");
});
test("new search supersedes a held response without clearing its busy state", async () => {
  const calls = fixture(), c = controller(); c.setQuery("A"); const a = c.search();
  c.setQuery("B"); const b = c.search();
  expect(calls[0]!.init?.signal?.aborted).toBe(true);
  calls[0]!.resolve(page([post("https://other.fixture.test/posts/A")])); await a;
  expect(c.getState().loading).toBe(true); expect(c.getState().posts).toHaveLength(0);
  calls[1]!.resolve(page([post("https://other.fixture.test/posts/B")])); await b;
  expect(c.getState().posts.map(p => p.ap_id)).toEqual(["https://other.fixture.test/posts/B"]);
});
test("pagination deduplicates cards but advances by raw rows and retries the original page", async () => {
  const calls = fixture(), c = controller(); c.setQuery("cats");
  let pending = c.search(); calls[0]!.resolve(page([post("https://p.test/1"), post("https://p.test/2")], true)); await pending;
  pending = c.loadMore(); expect(new URL(calls[1]!.url).searchParams.get("offset")).toBe("2");
  calls[1]!.resolve(page([post("https://p.test/2"), post("https://p.test/3")], true)); await pending;
  expect(c.getState().posts).toHaveLength(3); expect(c.getState().nextOffset).toBe(4);
  pending = c.loadMore(); calls[2]!.resolve(new Response("unavailable", { status: 503 })); await pending;
  expect(c.getState().posts).toHaveLength(3); expect(c.getState().nextOffset).toBe(4);
  c.setQuery("new draft"); c.setKind("actors"); pending = c.retry();
  expect(new URL(calls[3]!.url).searchParams.get("q")).toBe("cats");
  expect(new URL(calls[3]!.url).searchParams.get("offset")).toBe("4");
  calls[3]!.resolve(page()); await pending;
  expect(c.getState().query).toBe("new draft"); expect(c.getState().hasMore).toBe(false);
});
test("retrying a failed first query preserves new input and retries that captured query", async () => {
  const calls = fixture(), c = controller(); c.setQuery("original");
  let pending = c.search(); calls[0]!.resolve(new Response("error", { status: 500 })); await pending;
  c.setQuery("new unsent input"); c.setKind("actors"); pending = c.retry();
  expect(new URL(calls[1]!.url).searchParams.get("q")).toBe("original");
  expect(new URL(calls[1]!.url).pathname).toBe("/api/search/posts");
  calls[1]!.resolve(page([post()])); await pending;
  expect(c.getState().query).toBe("new unsent input"); expect(c.getState().kind).toBe("actors");
});
for (const change of ["close", "pause", "account", "endpoint", "dispose"] as const)
  test(`${change} cancels a held search and fences its late completion`, async () => {
    const calls = fixture(), c = controller(); c.setQuery("A"); const a = c.search();
    if (change === "account") c.updateSession({ ...session, accessToken: "new-fixture" });
    else if (change === "endpoint") c.updateSession({ ...session, apiBaseUrl: "https://other-api.fixture.test" });
    else c[change]();
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
    calls[0]!.resolve(page([post()])); await a;
    expect(c.getState().posts).toHaveLength(0); expect(c.getState().loading).toBe(false);
    if (change === "account" || change === "endpoint") expect(c.getState().query).toBe("");
  });
test("closing and reopening keeps query/results; confirmed projections remove deleted hits", async () => {
  const calls = fixture(), deleted = new Set<string>();
  const c = createSearchController({ session, projectPosts: rows => rows.filter(p => !deleted.has(p.ap_id)) });
  cleanups.push(() => c.dispose()); c.open(); c.setQuery("cats");
  const pending = c.search(); calls[0]!.resolve(page([post()])); await pending;
  c.close(); c.open(); expect(c.getState().posts).toHaveLength(1); expect(c.getState().query).toBe("cats");
  expect(calls).toHaveLength(1); deleted.add(post().ap_id); c.applyPostEdits(); expect(c.getState().posts).toHaveLength(0);
});
test("an explicit empty search link clears the old query and retires its held result", async () => {
  const calls = fixture(), c = controller(); c.setQuery("old"); const pending = c.search();
  c.open("", "actors"); expect(calls[0]!.init?.signal?.aborted).toBe(true);
  calls[0]!.resolve(page([post()])); await pending;
  expect(c.getState().query).toBe(""); expect(c.getState().kind).toBe("actors");
  expect(c.getState().loaded).toBe(false); expect(c.getState().posts).toHaveLength(0); expect(calls).toHaveLength(1);
});
test("cancellation stays attached while the actual response JSON body is pending", async () => {
  // A synthetic Response is not bound to fetch's AbortSignal. Use real HTTP
  // so cancellation exercises the actual body read, not a fake transport.
  let requested = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requested = true;
    return new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('{"posts":')); },
    }), { headers: { "content-type": "application/json" } });
  } }); cleanups.push(() => server.stop(true));
  const abort = new AbortController();
  const pending = loadMobileSearch({ ...session, hostUrl: server.url.origin }, "cats", "posts", 0, abort.signal);
  await until(() => requested); await Bun.sleep(5);
  abort.abort(new Error("caller retired"));
  await expect(pending).rejects.toThrow("caller retired");
});
test("real loopback HTTP uses the same search API and refuses redirects", async () => {
  const requests: { path: string; auth: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization") });
    return new URL(request.url).searchParams.get("q") === "redirect"
      ? Response.redirect("https://must-not-contact.invalid", 302) : page([post()]);
  } }); cleanups.push(() => server.stop(true));
  const selected = { ...session, hostUrl: server.url.origin };
  expect((await loadMobileSearch(selected, "cats", "posts")).posts).toHaveLength(1);
  await expect(loadMobileSearch(selected, "redirect", "posts")).rejects.toThrow();
  expect(requests).toEqual([{ path: "/api/search/posts", auth: "Bearer synthetic-search" }, { path: "/api/search/posts", auth: "Bearer synthetic-search" }]);
});
