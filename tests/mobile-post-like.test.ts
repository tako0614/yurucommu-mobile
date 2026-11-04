import { afterEach, expect, test } from "bun:test";
import * as api from "../src/api.ts";
import {
  createPostLikeController,
  createPostLikeStore,
} from "../src/post-like-controller.ts";
import { loadMobileNotificationPost } from "../src/notification-api.ts";
import type { MobileSession } from "@takosjp/mobile-kit";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const session: MobileSession = {
  product: "yurucommu",
  hostUrl: "https://likes.fixture.test",
  accessToken: "synthetic-like-fixture",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
const id = "https://remote.example/ap/posts/one?x=1&y=2";
const post = (extra: Record<string, unknown> = {}) => ({
  ap_id: id,
  type: "Note",
  content: "post",
  published: null,
  visibility: "public",
  community_ap_id: null,
  like_count: 3,
  reply_count: 0,
  author: {
    ap_id: "https://remote.example/users/author",
    preferred_username: "author",
    name: null,
    icon_url: null,
  },
  ...extra,
});

test("the native API exposes a selected-server like mutation", () => {
  expect(typeof (api as Record<string, unknown>).setMobilePostLike).toBe(
    "function",
  );
});
test("raw viewer liked state remains unknown when the server did not supply it", async () => {
  globalThis.fetch = (async () =>
    Response.json({ post: post() })) as unknown as typeof fetch;
  const value = await loadMobileNotificationPost(session, id);
  expect((value as unknown as Record<string, unknown>).likeState).toBeNull();
});

type Call = {
  url: string;
  init?: RequestInit;
  resolve: (response: Response) => void;
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
const ack = (liked = true) => Response.json({ success: true, liked });
const saved = (liked = true, count = 7) =>
  Response.json({ post: post({ liked, like_count: count }) });
const snapshot = (liked: boolean | null = false, count = 3) => ({
  ap_id: id,
  likeState: liked,
  like_count: count,
});

for (const target of [true, false])
  test(`like ${target} uses captured selected-host encoded route and persisted count`, async () => {
    const calls = fixture(),
      pending = api.setMobilePostLike(session, id, target);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).origin).toBe(session.hostUrl);
    expect(new URL(calls[0]!.url).pathname).toBe(
      `/api/posts/${encodeURIComponent(id)}/like`,
    );
    expect(calls[0]!.init).toMatchObject({
      method: target ? "POST" : "DELETE",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    calls[0]!.resolve(ack(target));
    await until(() => calls.length === 2);
    expect(new URL(calls[1]!.url).pathname).toBe(
      `/api/posts/${encodeURIComponent(id)}`,
    );
    expect(calls[1]!.init?.method).toBe("GET");
    calls[1]!.resolve(saved(target, 19));
    expect(await pending).toEqual({
      ap_id: id,
      likeState: target,
      like_count: 19,
    });
  });

for (const value of [
  { success: true },
  { success: false, liked: true },
  { success: true, liked: false },
])
  test("unconfirmed mutation ACK sends no readback or automatic mutation retry", async () => {
    const calls = fixture(),
      pending = api.setMobilePostLike(session, id, true);
    calls[0]!.resolve(Response.json(value));
    await expect(pending).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
for (const fields of [
  { ap_id: "https://wrong.example/post" },
  { liked: false },
  { liked: undefined },
  { like_count: -1 },
  { like_count: 1.5 },
  { like_count: Number.MAX_SAFE_INTEGER + 1 },
])
  test("mismatched or invalid persisted state is never accepted", async () => {
    const calls = fixture(),
      pending = api.setMobilePostLike(session, id, true);
    calls[0]!.resolve(ack());
    await until(() => calls.length === 2);
    calls[1]!.resolve(
      Response.json({ post: post({ liked: true, ...fields }) }),
    );
    await expect(pending).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
for (const status of [400, 401, 403, 404, 500])
  test(`server ${status} remains an uncertain result with no auto mutation`, async () => {
    const calls = fixture(),
      pending = api.setMobilePostLike(session, id, true);
    calls[0]!.resolve(Response.json({ error: "original refusal" }, { status }));
    await expect(pending).rejects.toThrow("original refusal");
    expect(calls).toHaveLength(1);
  });

test("raw known false/true and unknown flags are distinct in feed and details", async () => {
  for (const liked of [false, true, undefined, "false"]) {
    globalThis.fetch = (async () =>
      Response.json({ post: post({ liked }) })) as unknown as typeof fetch;
    expect((await loadMobileNotificationPost(session, id)).likeState).toBe(
      typeof liked === "boolean" ? liked : null,
    );
  }
});
test("unknown viewer state and malformed count cannot start a mutation", async () => {
  const calls = fixture();
  for (const value of [
    snapshot(null),
    snapshot(false, -1),
    snapshot(false, Number.MAX_SAFE_INTEGER + 1),
  ]) {
    const c = createPostLikeController({ session, post: value });
    await c.toggle();
    expect(c.getState().canToggle).toBe(false);
    c.dispose();
  }
  expect(calls).toHaveLength(0);
});
test("one pending operation owns both ACK and readback, and uses the server count", async () => {
  const calls = fixture(),
    c = createPostLikeController({ session, post: snapshot() });
  const pending = c.toggle();
  await c.toggle();
  expect(calls).toHaveLength(1);
  expect(c.getState().busy).toBe(true);
  calls[0]!.resolve(ack());
  await until(() => calls.length === 2);
  calls[1]!.resolve(saved(true, 41));
  await pending;
  expect(c.getState()).toMatchObject({
    liked: true,
    count: 41,
    busy: false,
    needsReload: false,
    status: "いいねを反映しました。",
  });
  c.dispose();
});
test("unknown ACK requires explicit GET recovery before another mutation", async () => {
  const calls = fixture(),
    c = createPostLikeController({ session, post: snapshot() });
  const pending = c.toggle();
  calls[0]!.resolve(Response.json({}));
  await pending;
  expect(c.getState()).toMatchObject({
    liked: false,
    needsReload: true,
    status: "",
  });
  await c.toggle();
  expect(calls).toHaveLength(1);
  c.updatePost(snapshot(false, 3));
  expect(c.getState().needsReload).toBe(true);
  const recovery = c.reload();
  expect(calls[1]!.init?.method ?? "GET").toBe("GET");
  calls[1]!.resolve(saved(true, 9));
  await recovery;
  expect(c.getState()).toMatchObject({
    liked: true,
    count: 9,
    needsReload: false,
  });
  const undo = c.toggle();
  expect(calls[2]!.init?.method).toBe("DELETE");
  calls[2]!.resolve(ack(false));
  await until(() => calls.length === 4);
  calls[3]!.resolve(saved(false, 8));
  await undo;
  expect(c.getState()).toMatchObject({
    liked: false,
    count: 8,
    status: "いいねを取り消しました。",
  });
  c.dispose();
});
for (const phase of ["ack", "readback"] as const)
  test(`hiding the card retires a held ${phase} and keeps unknown outcome`, async () => {
    const calls = fixture(),
      c = createPostLikeController({ session, post: snapshot() });
    const pending = c.toggle();
    if (phase === "readback") {
      calls[0]!.resolve(ack());
      await until(() => calls.length === 2);
    }
    c.setActive(false);
    const last = calls.at(-1)!;
    expect(last.init?.signal?.aborted).toBe(true);
    last.resolve(phase === "ack" ? ack() : saved());
    await pending;
    c.setActive(true);
    expect(c.getState()).toMatchObject({
      liked: false,
      needsReload: true,
      status: "",
    });
    expect(calls).toHaveLength(phase === "ack" ? 1 : 2);
    c.dispose();
  });
for (const change of ["session", "api", "post", "dispose"] as const)
  test(`${change} fences the old request without changing the new target`, async () => {
    const calls = fixture(),
      original = snapshot(),
      c = createPostLikeController({ session, post: original });
    const pending = c.toggle();
    if (change === "session")
      c.updateSession({ ...session, accessToken: "synthetic-new-viewer" });
    if (change === "api")
      c.updateSession({
        ...session,
        apiBaseUrl: "https://likes.fixture.test/other",
      });
    if (change === "post")
      c.updatePost({
        ...snapshot(true, 12),
        ap_id: "https://remote.example/other",
      });
    if (change === "dispose") c.dispose();
    expect(calls[0]!.init?.signal?.aborted).toBe(true);
    calls[0]!.resolve(ack());
    await pending;
    expect(calls).toHaveLength(1);
    if (change === "post")
      expect(c.getState()).toMatchObject({
        apId: "https://remote.example/other",
        liked: true,
        count: 12,
      });
    if (change === "session" || change === "api") {
      c.updatePost(original);
      await c.toggle();
      expect(c.getState().liked).toBeNull();
      expect(calls).toHaveLength(1);
    }
    c.dispose();
  });
test("a failed feed refresh does not turn a persisted like into an unknown mutation", async () => {
  const calls = fixture(),
    c = createPostLikeController({
      session,
      post: snapshot(),
      onChanged: async () => {
        throw Error("refresh failure");
      },
    });
  const pending = c.toggle();
  calls[0]!.resolve(ack());
  await until(() => calls.length === 2);
  calls[1]!.resolve(saved());
  await pending;
  expect(c.getState()).toMatchObject({
    liked: true,
    count: 7,
    needsReload: false,
  });
  expect(c.getState().refreshError).toContain("確認済み");
  c.dispose();
});
test("preaborted or inactive work dispatches zero requests", async () => {
  const calls = fixture(),
    abort = new AbortController();
  abort.abort();
  await expect(
    api.setMobilePostLike(session, id, true, abort.signal),
  ).rejects.toThrow();
  await expect(
    api.loadMobilePostLike(session, id, abort.signal),
  ).rejects.toThrow();
  const c = createPostLikeController({
    session,
    post: snapshot(),
    isActive: () => false,
  });
  await c.toggle();
  await c.reload();
  expect(calls).toHaveLength(0);
  c.dispose();
});
test("the existing 15s like budget includes a held persisted-state body", async () => {
  globalThis.fetch = originalFetch;
  let count = 0,
    aborted = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(request) {
      count++;
      if (request.method === "POST") return ack();
      request.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"post":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  try {
    const start = performance.now();
    await expect(
      api.setMobilePostLike(
        { ...session, hostUrl: server.url.origin },
        id,
        true,
      ),
    ).rejects.toThrow();
    expect(performance.now() - start).toBeGreaterThanOrEqual(14_000);
    await until(() => aborted);
    expect(count).toBe(2);
  } finally {
    server.stop(true);
  }
}, 20_000);

test("publishing an accepted receipt cannot refresh a replacement account", async () => {
  const calls = fixture();
  let refreshed = 0;
  let c: ReturnType<typeof createPostLikeController>;
  c = createPostLikeController({
    session,
    post: snapshot(),
    onChanged: async () => {
      refreshed++;
    },
    onChange: (state) => {
      if (state.status === "いいねを反映しました。")
        c.updateSession({ ...session, accessToken: "synthetic-replacement" });
    },
  });
  const pending = c.toggle();
  calls[0]!.resolve(ack());
  await until(() => calls.length === 2);
  calls[1]!.resolve(saved());
  await pending;
  expect(refreshed).toBe(0);
  expect(c.getState().liked).toBeNull();
  c.dispose();
});

async function readSnapshot(
  calls: Call[],
  liked = false,
  count = 3,
  selected = session,
) {
  const index = calls.length,
    pending = loadMobileNotificationPost(selected, id);
  calls[index]!.resolve(
    Response.json({ post: post({ liked, like_count: count }) }),
  );
  return pending;
}

test("same-post cards share in-flight exclusion, unknown state and explicit recovery", async () => {
  const calls = fixture(),
    initial = await readSnapshot(calls);
  const store = createPostLikeStore({ session });
  const a = store.acquire(initial, () => {}),
    b = store.acquire(initial, () => {});
  a.setActive(true);
  b.setActive(true);
  const pending = a.toggle();
  await b.toggle();
  expect(calls).toHaveLength(2);
  expect(b.getState().busy).toBe(true);
  calls[1]!.resolve(Response.json({}));
  await pending;
  expect(b.getState().needsReload).toBe(true);
  await b.toggle();
  expect(calls).toHaveLength(2);
  a.dispose();
  const newer = await readSnapshot(calls, false, 3);
  b.updatePost(newer);
  expect(b.getState().needsReload).toBe(true);
  const recovery = b.reload();
  calls[3]!.resolve(saved(true, 7));
  await recovery;
  expect(b.getState()).toMatchObject({
    liked: true,
    count: 7,
    needsReload: false,
  });
  const c = store.acquire(newer, () => {});
  c.setActive(true);
  expect(c.getState()).toMatchObject({ liked: true, count: 7 });
  b.dispose();
  c.dispose();
  store.dispose();
});

test("an actual earlier post GET cannot downgrade a confirmed shared like or count", async () => {
  const calls = fixture(),
    initial = await readSnapshot(calls);
  const store = createPostLikeStore({ session }),
    a = store.acquire(initial, () => {});
  a.setActive(true);
  const staleRead = loadMobileNotificationPost(session, id);
  const pending = a.toggle();
  calls[2]!.resolve(ack());
  await until(() => calls.length === 4);
  calls[3]!.resolve(saved(true, 17));
  await pending;
  calls[1]!.resolve(saved(false, 3));
  const stale = await staleRead;
  a.updatePost(stale);
  expect(a.getState()).toMatchObject({ liked: true, count: 17 });
  a.dispose();
  const b = store.acquire(stale, () => {});
  b.setActive(true);
  expect(b.getState()).toMatchObject({ liked: true, count: 17 });
  const fresh = await readSnapshot(calls, false, 2);
  b.updatePost(fresh);
  expect(b.getState()).toMatchObject({ liked: false, count: 2 });
  b.dispose();
  store.dispose();
});

test("only current-scope decoder provenance can seed a shared viewer flag", async () => {
  const calls = fixture(),
    old = await readSnapshot(calls);
  const store = createPostLikeStore({ session }),
    a = store.acquire(old, () => {});
  a.setActive(true);
  const pending = a.toggle();
  const next = { ...session, accessToken: "synthetic-other-account" };
  store.updateSession(next);
  expect(calls[1]!.init?.signal?.aborted).toBe(true);
  calls[1]!.resolve(ack());
  await pending;
  a.updatePost(old);
  await a.toggle();
  expect(calls).toHaveLength(2);
  expect(a.getState().liked).toBeNull();
  const fresh = await readSnapshot(calls, false, 4, next);
  a.updatePost(fresh);
  expect(a.getState()).toMatchObject({ liked: false, count: 4 });
  const fake = store.acquire(
    { ...snapshot(true, 999), ap_id: "https://remote.example/fake" },
    () => {},
  );
  fake.setActive(true);
  await fake.toggle();
  expect(fake.getState().liked).toBeNull();
  expect(calls).toHaveLength(3);
  fake.dispose();
  a.dispose();
  store.dispose();
});

test("releasing the last visible card retains an uncertain operation for another surface", async () => {
  const calls = fixture(),
    initial = await readSnapshot(calls);
  const store = createPostLikeStore({ session }),
    a = store.acquire(initial, () => {});
  a.setActive(true);
  const pending = a.toggle();
  a.dispose();
  expect(calls[1]!.init?.signal?.aborted).toBe(true);
  calls[1]!.resolve(ack());
  await pending;
  const fresh = await readSnapshot(calls, true, 4),
    b = store.acquire(fresh, () => {});
  b.setActive(true);
  expect(b.getState().needsReload).toBe(true);
  await b.toggle();
  expect(calls).toHaveLength(3);
  b.dispose();
  store.dispose();
});

test("a scope switch during shared notification cannot republish the old receipt to another card", async () => {
  const calls = fixture(),
    initial = await readSnapshot(calls);
  const store = createPostLikeStore({ session });
  let last: unknown;
  const a = store.acquire(initial, (state) => {
      if (state.status === "いいねを反映しました。")
        store.updateSession({
          ...session,
          accessToken: "synthetic-next-scope",
        });
    }),
    b = store.acquire(initial, (state) => {
      last = state;
    });
  a.setActive(true);
  b.setActive(true);
  const pending = a.toggle();
  calls[1]!.resolve(ack());
  await until(() => calls.length === 3);
  calls[2]!.resolve(saved());
  await pending;
  expect(last).toMatchObject({ liked: null, count: 0, status: "" });
  expect(b.getState().liked).toBeNull();
  a.dispose();
  b.dispose();
  store.dispose();
});
