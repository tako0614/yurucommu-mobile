import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { setMobilePostBookmark } from "../src/api.ts";
import { createNotificationController } from "../src/notification-controller.ts";
import { loadMobileNotificationPost } from "../src/notification-api.ts";

const originalFetch = globalThis.fetch;
const stops: (() => void)[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  stops.splice(0).forEach((stop) => stop());
});
const session: MobileSession = {
  product: "yurucommu",
  hostUrl: "https://a.social.example",
  accessToken: "synthetic-bookmark-a",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
const id = "https://remote.example/ap/posts/saved?x=1&y=2";
const actor = {
  ap_id: "https://remote.example/ap/users/peer",
  preferred_username: "peer",
  name: "Peer",
  icon_url: null,
};
const post = (bookmarked: unknown) => ({
  post: {
    ap_id: id,
    content: "Saved post",
    published: null,
    author: actor,
    bookmarked,
  },
});
const ack = (bookmarked: boolean) =>
  Response.json({ success: true, bookmarked });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const requests: {
    url: string;
    method: string;
    init?: RequestInit;
    resolve: (response: Response) => void;
  }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        init,
        resolve,
      });
    })) as typeof fetch;
  return requests;
}

test("save and remove adopt only the exact ACK, serialize clicks, and invalidate saved reads", async () => {
  const requests = fixture();
  let changed = 0;
  const c = createNotificationController({
    session,
    onBookmarksChanged: () => changed++,
  });
  const read = c.openPost(id);
  requests[0]!.resolve(Response.json(post(false)));
  await read;
  const save = c.toggleBookmark();
  await c.toggleBookmark();
  await c.reload();
  expect(requests.map((r) => r.method)).toEqual(["GET", "POST"]);
  expect(c.getState()).toMatchObject({
    bookmarkBusy: true,
    post: { bookmarkState: false },
  });
  requests[1]!.resolve(ack(true));
  await save;
  expect(c.getState()).toMatchObject({
    bookmarkBusy: false,
    bookmarkNeedsReload: false,
    post: { bookmarkState: true, bookmarked: true },
  });
  const remove = c.toggleBookmark();
  requests[2]!.resolve(ack(false));
  await remove;
  expect(c.getState().post?.bookmarkState).toBe(false);
  expect(changed).toBe(2);
  for (const request of requests.slice(1)) {
    expect(request.url).toBe(
      `${session.hostUrl}/api/posts/${encodeURIComponent(id)}/bookmark`,
    );
    expect(new Headers(request.init?.headers).get("authorization")).toBe(
      "Bearer synthetic-bookmark-a",
    );
    expect(request.init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  }
  expect(requests[2]!.method).toBe("DELETE");
  c.dispose();
});

for (const flag of [undefined, null, "true", 1, {}]) {
  test(`unknown wire bookmark state cannot become an inferred mutation: ${JSON.stringify(flag)}`, async () => {
    globalThis.fetch = (async () =>
      Response.json(post(flag))) as unknown as typeof fetch;
    const p = await loadMobileNotificationPost(session, id);
    expect(p.bookmarkState).toBeNull();
    const requests = fixture();
    const c = createNotificationController({ session });
    const read = c.openPost(id);
    requests[0]!.resolve(Response.json(post(flag)));
    await read;
    await c.toggleBookmark();
    expect(requests).toHaveLength(1);
    c.dispose();
  });
}

for (const response of [
  () => Response.json({ success: true }),
  () => Response.json({ success: true, bookmarked: false }),
  () => Response.json({ success: "true", bookmarked: true }),
  () => Response.json({ error: "Already bookmarked" }, { status: 400 }),
  () => new Response("bad gateway", { status: 503 }),
  () => new Response("{broken"),
  () => new Response(null, { status: 204 }),
  () =>
    Response.json({
      success: true,
      bookmarked: true,
      padding: "x".repeat(17_000),
    }),
]) {
  test(`failed or unverified ACK requires a GET instead of a second mutation (${response().status}, ${response().headers.get("content-type")})`, async () => {
    const requests = fixture();
    let changed = 0;
    const c = createNotificationController({
      session,
      onBookmarksChanged: () => changed++,
    });
    const read = c.openPost(id);
    requests[0]!.resolve(Response.json(post(false)));
    await read;
    const write = c.toggleBookmark();
    requests[1]!.resolve(response());
    await write;
    expect(c.getState()).toMatchObject({
      bookmarkBusy: false,
      bookmarkNeedsReload: true,
      post: { bookmarkState: false },
    });
    expect(c.getState().bookmarkError).toContain("保存結果");
    await c.toggleBookmark();
    expect(requests).toHaveLength(2);
    expect(changed).toBe(1);
    const reconcile = c.retry();
    expect(requests[2]!.method).toBe("GET");
    requests[2]!.resolve(Response.json(post(true)));
    await reconcile;
    expect(c.getState()).toMatchObject({
      bookmarkNeedsReload: false,
      bookmarkError: "",
      post: { bookmarkState: true },
    });
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    c.dispose();
  });
}

for (const transition of [
  "back",
  "session",
  "dispose",
  "other-post",
] as const) {
  test(`${transition} aborts the owned write and cannot adopt its late ACK`, async () => {
    const requests = fixture();
    let changed = 0;
    const c = createNotificationController({
      session,
      onBookmarksChanged: () => changed++,
    });
    const read = c.openPost(id);
    requests[0]!.resolve(Response.json(post(false)));
    await read;
    const write = c.toggleBookmark();
    let next: Promise<void> | undefined;
    if (transition === "back") c.back();
    if (transition === "session")
      c.updateSession({ ...session, accessToken: "synthetic-bookmark-b" });
    if (transition === "dispose") c.dispose();
    if (transition === "other-post")
      next = c.openPost("https://remote.example/ap/posts/next");
    expect(requests[1]!.init?.signal?.aborted).toBe(true);
    requests[1]!.resolve(ack(true));
    await write;
    expect(c.getState().post).toBeUndefined();
    expect(c.getState().bookmarkBusy).toBe(false);
    expect(changed).toBe(
      transition === "back" || transition === "other-post" ? 1 : 0,
    );
    if (next) {
      requests[2]!.resolve(
        Response.json({
          post: {
            ...post(false).post,
            ap_id: "https://remote.example/ap/posts/next",
          },
        }),
      );
      await next;
    }
    c.dispose();
  });
}

test("parallel native accounts capture their own selected-host credential", async () => {
  const requests = fixture();
  const a = setMobilePostBookmark(session, id, true);
  const b = setMobilePostBookmark(
    {
      ...session,
      hostUrl: "https://b.social.example",
      accessToken: "synthetic-bookmark-b",
    },
    id,
    false,
  );
  expect(requests.map((r) => new URL(r.url).origin)).toEqual([
    session.hostUrl,
    "https://b.social.example",
  ]);
  expect(
    requests.map((r) => new Headers(r.init?.headers).get("authorization")),
  ).toEqual(["Bearer synthetic-bookmark-a", "Bearer synthetic-bookmark-b"]);
  requests[1]!.resolve(ack(false));
  await b;
  requests[0]!.resolve(ack(true));
  await a;
});

test("pre-cancelled save sends no HTTP request", async () => {
  const requests = fixture(),
    owner = new AbortController();
  owner.abort();
  await expect(
    setMobilePostBookmark(session, id, true, owner.signal),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
});

test("a held real HTTP mutation body retains the original 15s deadline and never retries", async () => {
  const headers = deferred<void>();
  let calls = 0,
    aborted = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(request) {
      calls++;
      request.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"success":true,'));
            headers.resolve();
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  const selected = { ...session, hostUrl: server.url.origin };
  const start = performance.now();
  const outcome = setMobilePostBookmark(selected, id, true).then(
    () => ({ ok: true, cause: "" }),
    (error: unknown) => ({ ok: false, cause: String(error) }),
  );
  await headers.promise;
  const result = await outcome;
  expect(result.ok).toBe(false);
  expect(result.cause).toContain("時間内");
  expect(performance.now() - start).toBeGreaterThanOrEqual(14_000);
  const until = Date.now() + 500;
  while (!aborted && Date.now() < until) await Bun.sleep(5);
  expect(aborted).toBe(true);
  expect(calls).toBe(1);
}, 20_000);
