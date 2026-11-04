import { afterEach, expect, test } from "bun:test";
import { createNotificationController } from "../src/notification-controller.ts";
import { loadHome, loadYurucommuMobileBookmarksPage } from "../src/api.ts";
import {
  loadMobileNotificationPost,
  loadMobileNotifications,
} from "../src/notification-api.ts";
import { createFeedHomeLoader } from "../src/feed-home-loader.ts";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const transition of ["dispose", "back", "session"] as const) {
  test(`${transition} cancels the real post reader HTTP body after headers`, async () => {
    let sawHeaders!: () => void, sawAbort!: () => void;
    const headers = new Promise<void>((done) => {
      sawHeaders = done;
    });
    const aborted = new Promise<string>((done) => {
      sawAbort = () => done("aborted");
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 30,
      fetch(request) {
        expect(request.headers.get("authorization")).toBe(
          "Bearer read-lifetime-fixture",
        );
        request.signal.addEventListener("abort", sawAbort, { once: true });
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"post":'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const response = await originalFetch(input, init);
      sawHeaders();
      return response;
    }) as unknown as typeof fetch;
    const controller = createNotificationController({
      session: {
        hostUrl: server.url.origin,
        product: "yurucommu",
        accessToken: "read-lifetime-fixture",
        tokenType: "Bearer",
        createdAt: "2026-11-04T00:00:00Z",
      },
    });
    const pending = controller.openPost("https://remote.example/ap/posts/held");
    try {
      await headers;
      await Bun.sleep(0);
      if (transition === "dispose") controller.dispose();
      else if (transition === "back") await controller.back();
      else
        controller.updateSession({
          hostUrl: server.url.origin,
          product: "yurucommu",
          accessToken: "next-fixture-incarnation",
          tokenType: "Bearer",
          createdAt: "2026-11-04T00:00:00Z",
        });
      expect(
        await Promise.race([
          pending.then(() => "settled"),
          Bun.sleep(500).then(() => "still reading body"),
        ]),
      ).toBe("settled");
      expect(
        await Promise.race([
          aborted,
          Bun.sleep(500).then(() => "HTTP still open"),
        ]),
      ).toBe("aborted");
      expect(controller.getState()).toMatchObject({
        page: "home",
        loading: false,
        error: "",
      });
    } finally {
      controller.dispose();
      server.stop(true);
      await pending;
    }
  });
}

test("the original 15-second read budget includes a stalled post body and permits retry", async () => {
  let returned!: () => void,
    calls = 0;
  const headers = new Promise<void>((done) => {
    returned = done;
  });
  const id = "https://remote.example/ap/posts/timeout";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch() {
      calls++;
      if (calls > 1)
        return Response.json({
          post: {
            ap_id: id,
            content: "retried post",
            published: null,
            author: {
              ap_id: "https://fixture.example/ap/users/owner",
              preferred_username: "fixture",
              name: null,
              icon_url: null,
            },
          },
        });
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"post":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    returned();
    return response;
  }) as unknown as typeof fetch;
  const controller = createNotificationController({
    session: {
      hostUrl: server.url.origin,
      product: "yurucommu",
      accessToken: "read-lifetime-fixture",
      tokenType: "Bearer",
      createdAt: "2026-11-04T00:00:00Z",
    },
  });
  const start = performance.now();
  const pending = controller.openPost(id);
  try {
    await headers;
    await pending;
    expect(performance.now() - start).toBeGreaterThanOrEqual(14_000);
    expect(controller.getState().loading).toBe(false);
    expect(controller.getState().error).toContain("時間内");
    expect(calls).toBe(1);
    await controller.retry();
    expect(calls).toBe(2);
    expect(controller.getState().post?.content).toBe("retried post");
    expect(controller.getState().error).toBe("");
  } finally {
    controller.dispose();
    server.stop(true);
    await pending;
  }
}, 20_000);

test("a failed home member cancels its other real HTTP response instead of returning partial home", async () => {
  let timelineHeader!: () => void, timelineAbort!: () => void;
  const headers = new Promise<void>((done) => {
    timelineHeader = done;
  });
  const aborted = new Promise<string>((done) => {
    timelineAbort = () => done("aborted");
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/timeline") {
        request.signal.addEventListener("abort", timelineAbort, { once: true });
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"posts":'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/api/auth/me")
        return Response.json({
          actor: {
            ap_id: "https://fixture.example/ap/users/owner",
            preferred_username: "fixture",
            name: null,
            icon_url: null,
          },
        });
      await headers;
      return Response.json(
        { error: "fixture unread unavailable" },
        { status: 503 },
      );
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname === "/api/timeline") timelineHeader();
    return response;
  }) as unknown as typeof fetch;
  try {
    await expect(
      loadHome({
        hostUrl: server.url.origin,
        product: "yurucommu",
        accessToken: "read-lifetime-fixture",
        tokenType: "Bearer",
        createdAt: "2026-11-04T00:00:00Z",
      }),
    ).rejects.toThrow("fixture unread unavailable");
    expect(
      await Promise.race([
        aborted,
        Bun.sleep(500).then(() => "HTTP still open"),
      ]),
    ).toBe("aborted");
  } finally {
    server.stop(true);
  }
});

test("releasing the mounted home loader cancels its actual in-flight batch", async () => {
  let timelineHeader!: () => void, timelineAbort!: () => void;
  const headers = new Promise<void>((done) => {
    timelineHeader = done;
  });
  const aborted = new Promise<string>((done) => {
    timelineAbort = () => done("aborted");
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/timeline") {
        request.signal.addEventListener("abort", timelineAbort, { once: true });
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"posts":'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return path === "/api/auth/me"
        ? Response.json({
            actor: {
              ap_id: "https://fixture.example/ap/users/owner",
              preferred_username: "fixture",
              name: null,
              icon_url: null,
            },
          })
        : Response.json({ count: 0 });
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname === "/api/timeline") timelineHeader();
    return response;
  }) as unknown as typeof fetch;
  const session = {
    hostUrl: server.url.origin,
    product: "yurucommu" as const,
    accessToken: "read-lifetime-fixture",
    tokenType: "Bearer",
    createdAt: "2026-11-04T00:00:00Z",
  };
  const loader = createFeedHomeLoader({ loadHome });
  const release = loader.mount({ session }, () => {});
  const pending = loader.load(session),
    settled = pending.then(
      () => "incorrect partial home",
      () => "cancelled",
    );
  try {
    await headers;
    release();
    expect(
      await Promise.race([
        settled,
        Bun.sleep(500).then(() => "still reading home"),
      ]),
    ).toBe("cancelled");
    expect(
      await Promise.race([
        aborted,
        Bun.sleep(500).then(() => "HTTP still open"),
      ]),
    ).toBe("aborted");
  } finally {
    release();
    server.stop(true);
    await settled;
  }
});

test("a new credential incarnation cancels the old home read and settles its callers with the new revision", async () => {
  let oldHeader!: () => void, oldAbort!: () => void;
  const headers = new Promise<void>((done) => {
    oldHeader = done;
  });
  const aborted = new Promise<string>((done) => {
    oldAbort = () => done("aborted");
  });
  const requests: Array<{ path: string; auth: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(request) {
      const path = new URL(request.url).pathname,
        auth = request.headers.get("authorization");
      requests.push({ path, auth });
      if (
        path === "/api/timeline" &&
        auth === "Bearer first-fixture-incarnation"
      ) {
        request.signal.addEventListener("abort", oldAbort, { once: true });
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"posts":'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (path === "/api/auth/me")
        return Response.json({
          actor: {
            ap_id: "https://fixture.example/ap/users/owner",
            preferred_username: "fixture",
            name: null,
            icon_url: null,
          },
        });
      return Response.json(
        path === "/api/timeline" ? { posts: [] } : { count: 0 },
      );
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (
      new URL(String(input)).pathname === "/api/timeline" &&
      new Headers(init?.headers).get("authorization") ===
        "Bearer first-fixture-incarnation"
    )
      oldHeader();
    return response;
  }) as unknown as typeof fetch;
  const first = {
      hostUrl: server.url.origin,
      product: "yurucommu" as const,
      accessToken: "first-fixture-incarnation",
      tokenType: "Bearer",
      createdAt: "2026-11-04T00:00:00Z",
    },
    next = { ...first, accessToken: "next-fixture-incarnation" };
  const snapshots: string[] = [];
  const loader = createFeedHomeLoader({ loadHome }),
    release = loader.mount({ session: first }, (value) => {
      if (value.home) snapshots.push(value.session.accessToken);
    });
  const before = loader.load(first);
  let after: ReturnType<typeof loadHome> | undefined;
  const settled = before.then(
    (value) => ({ value }),
    (cause) => ({ cause }),
  );
  try {
    await headers;
    after = loader.load(next);
    const value = await Promise.race([
      after,
      Bun.sleep(500).then(() => "still waiting for old body"),
    ]);
    if (typeof value !== "object" || value === null)
      throw new Error(
        "new revision did not settle while the old body was held",
      );
    expect(await settled).toEqual({ value });
    expect(
      await Promise.race([
        aborted,
        Bun.sleep(500).then(() => "old HTTP still open"),
      ]),
    ).toBe("aborted");
    expect(snapshots).toEqual(["next-fixture-incarnation"]);
    expect(
      requests
        .filter((x) => x.auth === "Bearer next-fixture-incarnation")
        .map((x) => x.path)
        .sort(),
    ).toEqual(
      [
        "/api/auth/me",
        "/api/notifications/unread/count",
        "/api/timeline",
      ].sort(),
    );
  } finally {
    release();
    server.stop(true);
    await settled;
    await after?.catch(() => {});
  }
});

test("pre-cancelled read owners never create an authenticated request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("unexpected request");
  }) as unknown as typeof fetch;
  const signal = new AbortController();
  signal.abort(new Error("fixture owner ended"));
  const session = {
    hostUrl: "https://fixture.example",
    product: "yurucommu" as const,
    accessToken: "read-lifetime-fixture",
    tokenType: "Bearer",
    createdAt: "2026-11-04T00:00:00Z",
  };
  await expect(loadHome(session, signal.signal)).rejects.toThrow(
    "fixture owner ended",
  );
  await expect(
    loadYurucommuMobileBookmarksPage(session, signal.signal),
  ).rejects.toThrow("fixture owner ended");
  await expect(
    loadMobileNotifications(session, undefined, signal.signal),
  ).rejects.toThrow("fixture owner ended");
  await expect(
    loadMobileNotificationPost(
      session,
      "https://remote.example/ap/posts/a",
      signal.signal,
    ),
  ).rejects.toThrow("fixture owner ended");
  expect(calls).toBe(0);
});
