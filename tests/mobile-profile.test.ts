import { expect, test } from "bun:test";
import { createNotificationController } from "../src/notification-controller.ts";
import { createHostRouteHandoff } from "../src/host-route.ts";
const session = {
  product: "yurucommu" as const,
  hostUrl: "https://profiles.fixture.test",
  accessToken: "synthetic-profile",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
test("native profile navigation can pause an underlying post without clearing it", () => {
  const c = createNotificationController({ session });
  expect(typeof (c as unknown as Record<string, unknown>).pause).toBe(
    "function",
  );
  c.dispose();
});
test("a selected-server profile link reaches a native profile target", async () => {
  let value: unknown;
  const open = createHostRouteHandoff(
    () => {},
    (request) => {
      value = request.target;
    },
  );
  const id = "https://remote.example/users/author";
  await open({
    session,
    path: "/profile/" + encodeURIComponent(id),
    url: session.hostUrl + "/profile/" + encodeURIComponent(id),
  });
  expect(value).toEqual({ page: "profile", identifier: id });
});

import { afterEach } from "bun:test";
import {
  loadMobileProfile,
  loadMobileProfilePosts,
} from "../src/profile-api.ts";
import { createProfileController } from "../src/profile-controller.ts";
import { createPostLikeStore } from "../src/post-like-controller.ts";
const originalFetch = globalThis.fetch;
const cleanup: (() => void)[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup.splice(0).forEach((fn) => fn());
});
const actorId = "https://remote.example/users/author",
  postId = "https://remote.example/posts/root?x=1&y=2";
const actor = (extra: Record<string, unknown> = {}) => ({
  ap_id: actorId,
  preferred_username: "author",
  username: "author@remote.example",
  name: "Author",
  summary: "<p>Profile</p>",
  icon_url: null,
  fields: [],
  ...extra,
});
const note = (id = postId, extra: Record<string, unknown> = {}) => ({
  ap_id: id,
  type: "Note",
  content: "post",
  summary: null,
  attachments: [],
  published: null,
  visibility: "public",
  community_ap_id: null,
  in_reply_to: null,
  like_count: 0,
  reply_count: 0,
  liked: false,
  author: {
    ap_id: actorId,
    preferred_username: "author",
    name: "Author",
    icon_url: null,
  },
  ...extra,
});
const page = (rows: unknown[] = [], cursor: string | null = null) =>
  Response.json({
    posts: rows,
    has_more: cursor !== null,
    next_cursor: cursor,
  });
type Call = {
  url: string;
  init?: RequestInit;
  resolve: (value: Response) => void;
};
function fixture() {
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) =>
      calls.push({ url: String(input), init, resolve }),
    )) as unknown as typeof fetch;
  return calls;
}
async function until(check: () => boolean) {
  const end = Date.now() + 1000;
  while (!check() && Date.now() < end) await Bun.sleep(1);
  expect(check()).toBe(true);
}
async function openProfile(
  c: ReturnType<typeof createProfileController>,
  calls: Call[],
  first = page([note()], "opaque + next"),
) {
  const start = calls.length,
    pending = c.open(actorId);
  calls[start]!.resolve(Response.json({ actor: actor() }));
  await until(() => calls.length === start + 2);
  calls[start + 1]!.resolve(first);
  await pending;
}

test("canonical profile identity is read through the selected server, with remote counts kept unknown", async () => {
  const calls = fixture(),
    pending = loadMobileProfile(session, actorId);
  expect(calls[0]!.url).toBe(
    session.hostUrl + "/api/actors/" + encodeURIComponent(actorId),
  );
  expect(calls[0]!.init).toMatchObject({
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  calls[0]!.resolve(Response.json({ actor: actor() }));
  const result = await pending;
  expect(result).toMatchObject({
    ap_id: actorId,
    follower_count: null,
    following_count: null,
    post_count: null,
    is_private: null,
  });
});
test("own profile derives its canonical ID from actual selected-session auth/me", async () => {
  const calls = fixture(),
    pending = loadMobileProfile(session, null);
  expect(new URL(calls[0]!.url).pathname).toBe("/api/auth/me");
  calls[0]!.resolve(Response.json({ actor: actor() }));
  await until(() => calls.length === 2);
  expect(calls[1]!.url).toContain(encodeURIComponent(actorId));
  calls[1]!.resolve(
    Response.json({ actor: actor({ follower_count: 0, is_private: 1 }) }),
  );
  expect(await pending).toMatchObject({ follower_count: 0, is_private: true });
});
for (const fields of [
  { ap_id: "https://wrong.example/users/author" },
  { follower_count: -1 },
  { following_count: "0" },
  { post_count: 1.5 },
  { fields: [{ name: "bad", value: 5 }] },
])
  test("invalid profile metadata or a mismatched canonical identity is rejected", async () => {
    const calls = fixture(),
      pending = loadMobileProfile(session, actorId);
    calls[0]!.resolve(Response.json({ actor: actor(fields) }));
    await expect(pending).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
test("a qualified handle cannot resolve to a lookalike host", async () => {
  const calls = fixture(),
    pending = loadMobileProfile(session, "author@REMOTE.EXAMPLE");
  expect(calls[0]!.url).toContain("author%40remote.example");
  calls[0]!.resolve(
    Response.json({
      actor: actor({ ap_id: "https://remote.example.evil/users/author" }),
    }),
  );
  await expect(pending).rejects.toThrow();
});
for (const value of [
  "javascript:alert(1)",
  "//remote.example/actor",
  "https://user:pass@remote.example/actor",
  " bad",
  "bad/path",
])
  test("unsafe profile identifiers send zero requests", async () => {
    const calls = fixture();
    await expect(loadMobileProfile(session, value)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
test("profile post pages preserve cursor bytes, canonical author and decoder like provenance", async () => {
  const calls = fixture(),
    pending = loadMobileProfilePosts(session, actorId, "opaque + cursor");
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe(
    "/api/actors/" + encodeURIComponent(actorId) + "/posts",
  );
  expect(url.searchParams.get("before")).toBe("opaque + cursor");
  expect(url.searchParams.get("limit")).toBe("20");
  calls[0]!.resolve(page([note()]));
  const result = await pending;
  const likes = createPostLikeStore({ session }),
    handle = likes.acquire(result.posts[0]!, () => {});
  handle.setActive(true);
  expect(handle.getState().canToggle).toBe(true);
  handle.dispose();
  likes.dispose();
});
for (const fields of [
  {
    author: {
      ap_id: "https://other.example/actor",
      preferred_username: "other",
      name: null,
      icon_url: null,
    },
  },
  { type: undefined },
  { in_reply_to: undefined },
  { in_reply_to: "https://remote.example/reply-parent" },
])
  test("profile pages never normalize a wrong author or missing root-post binding into success", async () => {
    const calls = fixture(),
      pending = loadMobileProfilePosts(session, actorId);
    calls[0]!.resolve(page([note(postId, fields)]));
    await expect(pending).rejects.toThrow();
  });
test("empty advancing pages remain distinct from end of list", async () => {
  const calls = fixture(),
    pending = loadMobileProfilePosts(session, actorId);
  calls[0]!.resolve(page([], "next"));
  expect(await pending).toMatchObject({
    posts: [],
    hasMore: true,
    nextCursor: "next",
  });
});
test("continuation retry preserves cursor, deduplicates rows and refuses cycles", async () => {
  const calls = fixture(),
    c = createProfileController({ session });
  await openProfile(c, calls);
  const more = c.loadMore();
  calls[2]!.resolve(new Response("failed", { status: 503 }));
  await more;
  expect(c.getState().postsError).not.toBe("");
  const retry = c.retryPosts();
  expect(new URL(calls[3]!.url).searchParams.get("before")).toBe(
    "opaque + next",
  );
  calls[3]!.resolve(
    page([note(), note("https://remote.example/posts/second")], "last"),
  );
  await retry;
  expect(c.getState().posts).toHaveLength(2);
  const cycle = c.loadMore();
  calls[4]!.resolve(page([], "last"));
  await cycle;
  expect(c.getState().postsError).toContain("位置");
  c.dispose();
});
test("actor failure and post-list failure have separate actionable recovery", async () => {
  const calls = fixture(),
    c = createProfileController({ session });
  const pending = c.open(actorId);
  calls[0]!.resolve(new Response("failed", { status: 503 }));
  await pending;
  expect(c.getState().error).not.toBe("");
  const retry = c.reload();
  calls[1]!.resolve(Response.json({ actor: actor() }));
  await until(() => calls.length === 3);
  calls[2]!.resolve(new Response("failed", { status: 503 }));
  await retry;
  expect(c.getState().error).toBe("");
  expect(c.getState().postsError).not.toBe("");
  const rows = c.retryPosts();
  calls[3]!.resolve(page([note()]));
  await rows;
  expect(c.getState().posts).toHaveLength(1);
  c.dispose();
});
for (const transition of ["close", "session", "dispose"] as const)
  test(`${transition} retires a held actor body and fences late completion`, async () => {
    const calls = fixture(),
      c = createProfileController({ session });
    const pending = c.open(actorId);
    if (transition === "close") c.close();
    if (transition === "session")
      c.updateSession({ ...session, accessToken: "synthetic-next" });
    if (transition === "dispose") c.dispose();
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
    calls[0]!.resolve(Response.json({ actor: actor() }));
    await pending;
    expect(calls).toHaveLength(1);
    expect(c.getState().visible).toBe(false);
    c.dispose();
  });
test("closing during the first post read can resume without a permanent empty state", async () => {
  const calls = fixture(),
    c = createProfileController({ session });
  const pending = c.open(actorId);
  calls[0]!.resolve(Response.json({ actor: actor() }));
  await until(() => calls.length === 2);
  c.close();
  calls[1]!.resolve(page([note()]));
  await pending;
  const resume = c.open(actorId);
  await until(() => calls.length === 3);
  calls[2]!.resolve(page([note()]));
  await resume;
  expect(c.getState().postsLoaded).toBe(true);
  expect(c.getState().posts).toHaveLength(1);
  c.dispose();
});
test("profile child drafts survive close and returning to the same post", async () => {
  const calls = fixture(),
    c = createProfileController({ session });
  await openProfile(c, calls);
  let pending = c.getPostController().openPost(postId);
  calls[2]!.resolve(Response.json({ post: note() }));
  await pending;
  c.getPostController().getReplyComposer()!.setDraft("child reply retained");
  c.close();
  await c.open(actorId);
  expect(c.getPostController().getState().page).toBe("home");
  pending = c.getPostController().openPost(postId);
  calls[3]!.resolve(Response.json({ post: note() }));
  await pending;
  expect(c.getPostController().getReplyComposer()!.getState().content).toBe(
    "child reply retained",
  );
  c.dispose();
});
test("declining a different canonical profile preserves the child post and draft", async () => {
  const calls = fixture(),
    c = createProfileController({ session, confirmDiscardReply: () => false });
  await openProfile(c, calls);
  const detail = c.getPostController().openPost(postId);
  calls[2]!.resolve(Response.json({ post: note() }));
  await detail;
  c.getPostController().getReplyComposer()!.setDraft("keep this");
  const other = c.open("https://other.example/actor");
  calls[3]!.resolve(
    Response.json({ actor: actor({ ap_id: "https://other.example/actor" }) }),
  );
  expect(await other).toBe(false);
  expect(c.getState().actor!.ap_id).toBe(actorId);
  expect(c.getPostController().getReplyComposer()!.getState().content).toBe(
    "keep this",
  );
  expect(calls).toHaveLength(4);
  c.dispose();
});
test("pausing an underlying conversation retains its draft and cancels held replies", async () => {
  const calls = fixture(),
    c = createNotificationController({ session });
  const detail = c.openPost(postId);
  calls[0]!.resolve(Response.json({ post: note() }));
  await detail;
  c.getReplyComposer()!.setDraft("underlying main reply");
  const reading = c.reloadReplies();
  c.pause();
  expect(calls[1]!.init?.signal?.aborted).toBe(true);
  calls[1]!.resolve(
    Response.json({ replies: [], has_more: false, next_cursor: null }),
  );
  await reading;
  expect(c.getState().post?.ap_id).toBe(postId);
  expect(c.getReplyComposer()!.getState().content).toBe(
    "underlying main reply",
  );
  expect(c.getState().repliesError).toContain("中断");
  c.dispose();
});
test("profile body decoding remains inside the existing 15s read budget", async () => {
  globalThis.fetch = originalFetch;
  let aborted = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(request) {
      request.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"actor":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  cleanup.push(() => server.stop(true));
  const start = performance.now();
  await expect(
    loadMobileProfile({ ...session, hostUrl: server.url.origin }, actorId),
  ).rejects.toThrow();
  expect(performance.now() - start).toBeGreaterThanOrEqual(14_000);
  await until(() => aborted);
}, 20_000);

test("only a still-owned decline can request origin focus, not a retired false result", async () => {
  const calls = fixture();
  let restored = 0;
  let resolveChoice: ((value: boolean) => void) | undefined;
  const c = createProfileController({
    session,
    onDeclined: () => {
      restored++;
    },
    confirmDiscardReply: () =>
      new Promise<boolean>((resolve) => {
        resolveChoice = resolve;
      }),
  });
  await openProfile(c, calls);
  let detail = c.getPostController().openPost(postId);
  calls[2]!.resolve(Response.json({ post: note() }));
  await detail;
  c.getPostController().getReplyComposer()!.setDraft("protected draft");
  c.close();
  let pending = c.open("https://other.example/actor");
  calls[3]!.resolve(
    Response.json({ actor: actor({ ap_id: "https://other.example/actor" }) }),
  );
  await until(() => !!resolveChoice);
  c.close();
  resolveChoice!(false);
  await pending;
  expect(restored).toBe(0);
  resolveChoice = undefined;
  pending = c.open("https://other.example/actor");
  calls[4]!.resolve(
    Response.json({ actor: actor({ ap_id: "https://other.example/actor" }) }),
  );
  await until(() => !!resolveChoice);
  resolveChoice!(false);
  await pending;
  expect(restored).toBe(1);
  expect(c.getState().visible).toBe(false);
  expect(c.getPostController().getReplyComposer()!.getState().content).toBe(
    "protected draft",
  );
  c.dispose();
});

test("an interrupted unaccepted target cannot become a cached profile identity", async () => {
  const calls = fixture(),
    c = createProfileController({ session });
  await openProfile(c, calls);
  const pending = c.open("https://other.example/actor");
  c.close();
  calls[2]!.resolve(
    Response.json({ actor: actor({ ap_id: "https://other.example/actor" }) }),
  );
  await pending;
  const retry = c.open("https://other.example/actor");
  expect(calls).toHaveLength(4);
  calls[3]!.resolve(
    Response.json({ actor: actor({ ap_id: "https://other.example/actor" }) }),
  );
  await until(() => calls.length === 5);
  calls[4]!.resolve(page());
  await retry;
  expect(c.getState().actor!.ap_id).toBe("https://other.example/actor");
  c.dispose();
});

test("covering an idle failed continuation preserves its exact reply retry cursor", async () => {
  const calls = fixture(),
    c = createNotificationController({ session });
  let pending: Promise<unknown> = c.openPost(postId);
  calls[0]!.resolve(Response.json({ post: note() }));
  await pending;
  pending = c.reloadReplies();
  calls[1]!.resolve(
    Response.json({
      replies: [],
      has_more: true,
      next_cursor: "reply + cursor",
    }),
  );
  await pending;
  pending = c.loadMoreReplies();
  calls[2]!.resolve(new Response("failed", { status: 503 }));
  await pending;
  c.pause();
  pending = c.retryReplies();
  expect(new URL(calls[3]!.url).searchParams.get("before")).toBe(
    "reply + cursor",
  );
  calls[3]!.resolve(
    Response.json({ replies: [], has_more: false, next_cursor: null }),
  );
  await pending;
  c.dispose();
});

test("covering a failed notification continuation preserves its retry position", async () => {
  const calls = fixture(),
    c = createNotificationController({ session });
  let pending = c.openNotifications();
  calls[0]!.resolve(
    Response.json({
      notifications: [],
      has_more: true,
      next_cursor: "notification + cursor",
    }),
  );
  await pending;
  pending = c.loadMore();
  calls[1]!.resolve(new Response("failed", { status: 503 }));
  await pending;
  c.pause();
  pending = c.retry() as Promise<void>;
  expect(new URL(calls[2]!.url).searchParams.get("before")).toBe(
    "notification + cursor",
  );
  calls[2]!.resolve(
    Response.json({ notifications: [], has_more: false, next_cursor: null }),
  );
  await pending;
  c.dispose();
});
