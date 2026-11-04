import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import {
  loadMobileNotificationPost,
  loadMobileNotifications,
} from "../src/notification-api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function session(
  host = "https://a.social.example",
  token = "fixture-a",
): MobileSession {
  return {
    hostUrl: host,
    product: "yurucommu",
    accessToken: token,
    tokenType: "Bearer",
    createdAt: "2026-11-04T00:00:00Z",
  };
}
function actor() {
  return {
    ap_id: "https://remote.example/ap/users/peer",
    preferred_username: "peer",
    username: "peer@remote.example",
    name: "Peer",
    icon_url: null,
  };
}
function notification(id = "event-a") {
  return {
    id,
    type: "reply",
    actor: actor(),
    object_ap_id: "https://remote.example/ap/posts/reply",
    read: false,
    created_at: "2026-11-04T00:00:00Z",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("notification reads capture each selected account before either response settles", async () => {
  const a = deferred<Response>(),
    b = deferred<Response>();
  const requests: Array<{
    url: string;
    authorization: string | null;
    method: string;
    credentials?: RequestCredentials;
  }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      method: init?.method ?? "GET",
      credentials: init?.credentials,
    });
    return requests.length === 1 ? a.promise : b.promise;
  }) as unknown as typeof fetch;
  const first = loadMobileNotifications(session(), "cursor with + / &");
  const second = loadMobileNotifications(
    session("https://b.social.example", "fixture-b"),
  );
  b.resolve(
    Response.json({
      notifications: [notification("event-b")],
      has_more: false,
      next_cursor: null,
    }),
  );
  expect((await second).notifications[0]?.id).toBe("event-b");
  a.resolve(
    Response.json({
      notifications: [notification()],
      has_more: true,
      next_cursor: "server-cursor",
    }),
  );
  const result = await first;
  expect(result.nextCursor).toBe("server-cursor");
  expect(result.hasMore).toBe(true);
  expect(result.notifications[0]?.target_kind).toBe("post");
  expect(requests).toEqual([
    {
      url: "https://a.social.example/api/notifications?limit=20&before=cursor+with+%2B+%2F+%26",
      authorization: "Bearer fixture-a",
      method: "GET",
      credentials: "omit",
    },
    {
      url: "https://b.social.example/api/notifications?limit=20",
      authorization: "Bearer fixture-b",
      method: "GET",
      credentials: "omit",
    },
  ]);
});

for (const payload of [
  { has_more: false },
  { notifications: null, has_more: false },
  { notifications: [], has_more: true, next_cursor: null },
  { notifications: [{ ...notification(), actor: null }], has_more: false },
  { notifications: [{ ...notification(), read: 1 }], has_more: false },
]) {
  test(`malformed notification success is rejected rather than shown empty: ${JSON.stringify(payload)}`, async () => {
    globalThis.fetch = (async () =>
      Response.json(payload)) as unknown as typeof fetch;
    await expect(loadMobileNotifications(session())).rejects.toThrow(
      "応答を確認",
    );
  });
}

test("a failed notification GET is surfaced once without mark-read, registration or retries", async () => {
  let count = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    count++;
    expect(init?.method ?? "GET").toBe("GET");
    return new Response("fixture unavailable", { status: 503 });
  }) as unknown as typeof fetch;
  await expect(loadMobileNotifications(session())).rejects.toThrow();
  expect(count).toBe(1);
});

test("remote notification posts use the connected server endpoint and bearer, not the remote origin", async () => {
  const apId = "https://remote.example/ap/posts/secret?x=1";
  const requests: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({
      post: {
        ap_id: apId,
        content: "Notification post",
        author: actor(),
        published: "2026-11-04T00:00:00Z",
      },
    });
  }) as unknown as typeof fetch;
  const result = await loadMobileNotificationPost(session(), apId);
  expect(result.ap_id).toBe(apId);
  expect(result.content).toBe("Notification post");
  expect(requests).toEqual([
    {
      url: `https://a.social.example/api/posts/${encodeURIComponent(apId)}`,
      authorization: "Bearer fixture-a",
    },
  ]);
});

test("a successful response containing another post is refused", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      post: {
        ap_id: "https://remote.example/ap/posts/other",
        content: "Other post",
        author: actor(),
        published: "2026-11-04T00:00:00Z",
      },
    })) as unknown as typeof fetch;
  await expect(
    loadMobileNotificationPost(
      session(),
      "https://remote.example/ap/posts/requested",
    ),
  ).rejects.toThrow("通知先の投稿");
});

for (const published of [undefined, { invalid: true }]) {
  test(`missing or malformed post date remains a response error: ${JSON.stringify(published)}`, async () => {
    const apId = "https://remote.example/ap/posts/target";
    globalThis.fetch = (async () =>
      Response.json({
        post: { ap_id: apId, content: "Target", author: actor(), published },
      })) as unknown as typeof fetch;
    await expect(loadMobileNotificationPost(session(), apId)).rejects.toThrow(
      "通知先の投稿",
    );
  });
}

test("an explicit unknown post date stays null without inventing a date from another field", async () => {
  const apId = "https://remote.example/ap/posts/target";
  globalThis.fetch = (async () =>
    Response.json({
      post: {
        ap_id: apId,
        content: "Target",
        author: actor(),
        published: null,
        created_at: "2026-11-01T00:00:00Z",
      },
    })) as unknown as typeof fetch;
  expect(
    (await loadMobileNotificationPost(session(), apId)).published,
  ).toBeNull();
});

test("an object in an actor display field is refused before it reaches the native view", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      notifications: [
        { ...notification(), actor: { ...actor(), name: { invalid: true } } },
      ],
      has_more: false,
      next_cursor: null,
    })) as unknown as typeof fetch;
  await expect(loadMobileNotifications(session())).rejects.toThrow(
    "通知の応答",
  );
});

test("nullable cached remote usernames retain the public SDK's display compatibility", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      notifications: [
        {
          ...notification(),
          actor: { ...actor(), preferred_username: null, name: null },
        },
      ],
      has_more: false,
      next_cursor: null,
    })) as unknown as typeof fetch;
  const result = await loadMobileNotifications(session());
  expect(result.notifications[0]!.actor.preferred_username).toBe("peer");
  expect(result.notifications[0]!.actor.name).toBeNull();
});
