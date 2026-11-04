import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { createNotificationController } from "../src/notification-controller.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const A: MobileSession = {
  hostUrl: "https://a.social.example",
  product: "yurucommu",
  tokenType: "Bearer",
  accessToken: "fixture-a",
  createdAt: "2026-11-04T00:00:00Z",
};
const B: MobileSession = {
  ...A,
  hostUrl: "https://b.social.example",
  accessToken: "fixture-b",
};
const actor = {
  ap_id: "https://remote.example/ap/users/peer",
  preferred_username: "peer",
  username: "peer@remote.example",
  name: "Peer",
  icon_url: null,
};
const postId = "https://remote.example/ap/posts/notification-target";
const note = (id: string) => ({
  id,
  type: "reply",
  actor,
  read: false,
  created_at: "2026-11-04T00:00:00Z",
  object_ap_id: postId,
});
const page = (ids: string[], cursor: string | null = null) =>
  Response.json({
    notifications: ids.map(note),
    has_more: cursor !== null,
    next_cursor: cursor,
  });

function fixture() {
  const requests: Array<{
    url: string;
    authorization: string | null;
    resolve: (response: Response) => void;
  }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        resolve,
      });
    })) as unknown as typeof fetch;
  return requests;
}

test("an old notification read cannot overwrite a newer post route", async () => {
  const requests = fixture();
  const c = createNotificationController({ session: A });
  const old = c.openNotifications();
  const post = c.openPost(postId);
  requests[1]!.resolve(
    Response.json({
      post: {
        ap_id: postId,
        content: "Selected post",
        author: actor,
        published: "2026-11-04T00:00:00Z",
      },
    }),
  );
  await post;
  requests[0]!.resolve(page(["stale"]));
  await old;
  expect(c.getState().page).toBe("post");
  expect(c.getState().post?.content).toBe("Selected post");
  expect(c.getState().notifications).toEqual([]);
});

test("A-B-A account transitions retire pending responses without reviving A's old list", async () => {
  const requests = fixture();
  const c = createNotificationController({ session: A });
  const old = c.openNotifications();
  c.updateSession(B);
  expect(c.getState().page).toBe("home");
  c.updateSession(A);
  const current = c.openNotifications();
  requests[1]!.resolve(page(["new-a"]));
  await current;
  requests[0]!.resolve(page(["old-a"]));
  await old;
  expect(c.getState().notifications.map((n) => n.id)).toEqual(["new-a"]);
});

test("switching hosts resets loaded data and dispatches the next request with B's captured bearer", async () => {
  const requests = fixture();
  const c = createNotificationController({ session: A });
  const first = c.openNotifications();
  requests[0]!.resolve(page(["a"]));
  await first;
  c.updateSession(B);
  expect(c.getState().notifications).toEqual([]);
  const next = c.openNotifications();
  expect(requests[1]).toMatchObject({
    url: "https://b.social.example/api/notifications?limit=20",
    authorization: "Bearer fixture-b",
  });
  requests[1]!.resolve(page(["b"]));
  await next;
  expect(c.getState().notifications.map((n) => n.id)).toEqual(["b"]);
});

test("same-session refresh preserves its current read", async () => {
  const requests = fixture();
  const c = createNotificationController({ session: A });
  const read = c.openNotifications();
  c.updateSession({ ...A });
  requests[0]!.resolve(page(["current"]));
  await read;
  expect(c.getState().notifications[0]?.id).toBe("current");
});

test("an explicit retry recovers a failed GET without automatic retries or a false empty list", async () => {
  const requests = fixture();
  const c = createNotificationController({ session: A });
  const read = c.openNotifications();
  requests[0]!.resolve(new Response("unavailable", { status: 503 }));
  await read;
  expect(c.getState().loading).toBe(false);
  expect(c.getState().listLoaded).toBe(false);
  expect(c.getState().error).not.toBe("");
  expect(requests).toHaveLength(1);
  const retry = c.retry();
  requests[1]!.resolve(page([]));
  await retry;
  expect(c.getState()).toMatchObject({
    listLoaded: true,
    error: "",
    loading: false,
  });
});

test("the server cursor and loaded list survive opening a post and returning", async () => {
  const requests = fixture();
  const c = createNotificationController({ session: A });
  const first = c.openNotifications();
  requests[0]!.resolve(page(["one"], "opaque + cursor"));
  await first;
  const more = c.loadMore();
  expect(requests[1]!.url).toContain("before=opaque+%2B+cursor");
  requests[1]!.resolve(page(["one", "two", "two"]));
  await more;
  expect(c.getState().notifications.map((n) => n.id)).toEqual(["one", "two"]);
  const list = c.getState().notifications;
  const post = c.openPost(postId);
  requests[2]!.resolve(
    Response.json({
      post: {
        ap_id: postId,
        content: "Target",
        author: actor,
        published: "2026-11-04T00:00:00Z",
      },
    }),
  );
  await post;
  await c.back();
  expect(c.getState().page).toBe("notifications");
  expect(c.getState().notifications).toBe(list);
  expect(requests).toHaveLength(3);
});

test("disposal fences a held read and refuses subsequent commands", async () => {
  const requests = fixture();
  const states: unknown[] = [];
  const c = createNotificationController({
    session: A,
    onChange: (state) => states.push(state),
  });
  const pending = c.openNotifications();
  const before = states.length;
  c.dispose();
  requests[0]!.resolve(page(["old"]));
  await pending;
  await c.openNotifications();
  expect(states).toHaveLength(before);
  expect(requests).toHaveLength(1);
  expect(c.getState().page).toBe("home");
});

test("Retry after a failed continuation preserves the list and retries its exact server cursor", async () => {
  const requests = fixture();
  const c = createNotificationController({ session: A });
  const first = c.openNotifications();
  requests[0]!.resolve(page(["one"], "failed-page-cursor"));
  await first;
  const retained = c.getState().notifications;
  const more = c.loadMore();
  requests[1]!.resolve(new Response("unavailable", { status: 503 }));
  await more;
  expect(c.getState().notifications).toBe(retained);
  expect(requests).toHaveLength(2);
  const retry = c.retry();
  const pendingRows = c.getState().notifications;
  const retriedUrl = requests[2]!.url;
  requests[2]!.resolve(page(["two"], "next-page-cursor"));
  await retry;
  expect(pendingRows).toBe(retained);
  expect(retriedUrl).toBe(
    "https://a.social.example/api/notifications?limit=20&before=failed-page-cursor",
  );
  expect(c.getState().notifications.map((n) => n.id)).toEqual(["one", "two"]);
  expect(c.getState().nextCursor).toBe("next-page-cursor");
  expect(c.getState().error).toBe("");
});

test("session reset clears the visible state even during a temporarily inactive view", async () => {
  const requests = fixture();
  let active = true;
  const states: unknown[] = [];
  const c = createNotificationController({
    session: A,
    isActive: () => active,
    onChange: (state) => states.push(state),
  });
  const pending = c.openNotifications();
  requests[0]!.resolve(page(["old"]));
  await pending;
  active = false;
  c.updateSession(B);
  expect(states.at(-1)).toMatchObject({ page: "home", notifications: [] });
});

test("Reload after a continuation error deliberately starts a fresh head instead of retrying its cursor", async () => {
  const requests = fixture();
  const c = createNotificationController({ session: A });
  const first = c.openNotifications();
  requests[0]!.resolve(page(["old"], "old-cursor"));
  await first;
  const more = c.loadMore();
  requests[1]!.resolve(new Response("unavailable", { status: 503 }));
  await more;
  const reload = c.reload();
  const pendingRows = c.getState().notifications;
  const url = requests[2]!.url;
  requests[2]!.resolve(page(["fresh"]));
  await reload;
  expect(pendingRows).toEqual([]);
  expect(url).toBe("https://a.social.example/api/notifications?limit=20");
  expect(c.getState().notifications.map((item) => item.id)).toEqual(["fresh"]);
});
