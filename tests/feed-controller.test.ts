import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { createFeedController } from "../src/feed-controller.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const session: MobileSession = {
  hostUrl: "https://social.example",
  product: "yurucommu",
  accessToken: "token-one",
  tokenType: "Bearer",
  createdAt: "2026-10-04T00:00:00.000Z",
  productEndpoints: undefined,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function emptyPostRequestLog() {
  return [] as Array<{
    url: string;
    method: string;
    authorization: string | null;
    body?: unknown;
  }>;
}

test("submit captures the original body and visibility while later edits survive its ACK", async () => {
  const post = deferred<Response>();
  const requests: Array<{ url: string; method: string; authorization: string | null; body?: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    return post.promise;
  }) as unknown as typeof fetch;
  const controller = createFeedController({ session, refreshHome: async () => {} });

  controller.setDraft("original body");
  controller.setVisibility("followers");
  const submitting = controller.submit();
  expect(controller.getState().sending).toBe(true);
  controller.setDraft("newer body");
  controller.setVisibility("unlisted");
  post.resolve(Response.json({ post: { ap_id: "https://social.example/ap/posts/1" } }));
  await submitting;

  expect(requests).toEqual([{
    url: "https://social.example/api/posts",
    method: "POST",
    authorization: "Bearer token-one",
    body: { content: "original body", visibility: "followers" },
  }]);
  expect(controller.getState()).toMatchObject({
    content: "newer body",
    visibility: "unlisted",
    sending: false,
    error: "",
    status: "投稿を送信しました。",
  });
});

test("an explicit clear made while a POST is pending survives its successful ACK", async () => {
  const post = deferred<Response>();
  globalThis.fetch = (async () => post.promise) as unknown as typeof fetch;
  const controller = createFeedController({ session, refreshHome: async () => {} });

  controller.setDraft("clear while pending");
  const submitting = controller.submit();
  controller.clearDraft();
  post.resolve(Response.json({ post: { ap_id: "https://social.example/ap/posts/2" } }));
  await submitting;

  expect(controller.getState()).toMatchObject({ content: "", sending: false, error: "" });
});

test("an invalid successful ACK keeps the draft and never retries automatically", async () => {
  const requests = emptyPostRequestLog();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    return Response.json({ post: { ap_id: "" } });
  }) as unknown as typeof fetch;
  const controller = createFeedController({ session, refreshHome: async () => {} });

  controller.setDraft("keep after uncertain outcome");
  await controller.submit();

  expect(controller.getState().content).toBe("keep after uncertain outcome");
  expect(controller.getState().sending).toBe(false);
  expect(controller.getState().error).toContain("再送する前に");
  expect(requests).toHaveLength(1);
});

test("a home refresh failure remains separate from an accepted post", async () => {
  const requests = emptyPostRequestLog();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    return Response.json({ post: { ap_id: "https://social.example/ap/posts/accepted-once" } });
  }) as unknown as typeof fetch;
  let refreshes = 0;
  const controller = createFeedController({
    session,
    refreshHome: async () => {
      refreshes += 1;
      throw new Error("home unavailable");
    },
  });

  controller.setDraft("accepted once");
  await controller.submit();
  await controller.submit();

  expect(controller.getState()).toMatchObject({
    content: "",
    sending: false,
    error: "",
    status: "投稿を送信しました。",
    refreshError: "投稿は送信済みです。フィードを更新できませんでした。",
  });
  expect(refreshes).toBe(1);
  expect(requests).toHaveLength(1);
});

test("a delayed refresh failure from an older post cannot overwrite the newer submit", async () => {
  const requests: unknown[] = [];
  const oldRefresh = deferred<void>();
  const newRefresh = deferred<void>();
  const firstRefreshStarted = deferred<void>();
  const secondRefreshStarted = deferred<void>();
  let refreshCount = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as unknown);
    return Response.json({
      post: { ap_id: `https://social.example/ap/posts/${requests.length}` },
    });
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: () => {
      refreshCount += 1;
      if (refreshCount === 1) {
        firstRefreshStarted.resolve(undefined);
        return oldRefresh.promise;
      }
      secondRefreshStarted.resolve(undefined);
      return newRefresh.promise;
    },
  });

  controller.setDraft("first accepted post");
  const firstSubmit = controller.submit();
  await firstRefreshStarted.promise;
  controller.setDraft("second accepted post");
  const secondSubmit = controller.submit();
  await secondRefreshStarted.promise;

  oldRefresh.reject(new Error("old feed read failed"));
  await firstSubmit;
  expect(controller.getState()).toMatchObject({
    content: "",
    sending: false,
    error: "",
    status: "投稿を送信しました。",
    refreshError: "",
  });

  newRefresh.resolve(undefined);
  await secondSubmit;
  expect(requests).toEqual([
    { content: "first accepted post", visibility: "public" },
    { content: "second accepted post", visibility: "public" },
  ]);
  expect(controller.getState().refreshError).toBe("");
});

test("an old authority ACK cannot clear, publish, refresh, or unlock its replacement send", async () => {
  const oldPost = deferred<Response>();
  const currentPost = deferred<Response>();
  const requests: Array<{ token: string; body?: unknown }> = [];
  const changes: string[] = [];
  let refreshes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ token, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) });
    return token === "Bearer token-one" ? oldPost.promise : currentPost.promise;
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: async () => { refreshes += 1; },
    onChange: (state) => changes.push(`${state.content}:${state.sending}:${state.status}`),
  });

  controller.setDraft("old authority post");
  const oldSubmit = controller.submit();
  controller.updateSession({ ...session, accessToken: "token-two" });
  controller.setDraft("new authority post");
  const newSubmit = controller.submit();
  const changesBeforeOldAck = changes.length;
  const refreshesBeforeOldAck = refreshes;
  oldPost.resolve(Response.json({ post: { ap_id: "https://social.example/ap/posts/old" } }));
  await oldSubmit;

  expect(controller.getState()).toMatchObject({ content: "new authority post", sending: true, status: "" });
  expect(changes).toHaveLength(changesBeforeOldAck);
  expect(refreshes).toBe(refreshesBeforeOldAck);

  currentPost.resolve(Response.json({ post: { ap_id: "https://social.example/ap/posts/new" } }));
  await newSubmit;
  expect(requests).toEqual([
    { token: "Bearer token-one", body: { content: "old authority post", visibility: "public" } },
    { token: "Bearer token-two", body: { content: "new authority post", visibility: "public" } },
  ]);
  expect(controller.getState().content).toBe("");
});

test("an old host and product-endpoint ACK cannot mutate the current draft or refresh it", async () => {
  const oldPost = deferred<Response>();
  const currentPost = deferred<Response>();
  const initialSession = {
    ...session,
    productEndpoints: { api: "/api-v1" },
  };
  const requests: Array<{ url: string; body?: unknown }> = [];
  let refreshes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    return requests.length === 1 ? oldPost.promise : currentPost.promise;
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session: initialSession,
    refreshHome: async () => { refreshes += 1; },
  });

  controller.setDraft("old host draft");
  const oldSubmit = controller.submit();
  controller.updateSession({
    ...initialSession,
    hostUrl: "https://other.example",
    product: "another-product",
    productEndpoints: { api: "/api-v2" },
  });
  controller.setDraft("current host draft");
  const newSubmit = controller.submit();
  oldPost.resolve(Response.json({ post: { ap_id: "https://social.example/ap/posts/old-host" } }));
  await oldSubmit;
  expect(controller.getState()).toMatchObject({ content: "current host draft", sending: true });
  expect(refreshes).toBe(0);

  currentPost.resolve(Response.json({ post: { ap_id: "https://other.example/ap/posts/current" } }));
  await newSubmit;
  expect(requests).toEqual([
    {
      url: "https://social.example/api/posts",
      body: { content: "old host draft", visibility: "public" },
    },
    {
      url: "https://other.example/api/posts",
      body: { content: "current host draft", visibility: "public" },
    },
  ]);
});

test("separate controllers with the same credentials own independent pending sends", async () => {
  const posts = [deferred<Response>(), deferred<Response>()];
  let requestIndex = 0;
  globalThis.fetch = (async () => posts[requestIndex++]!.promise) as unknown as typeof fetch;
  const first = createFeedController({ session, refreshHome: async () => {} });
  const second = createFeedController({ session, refreshHome: async () => {} });
  first.setDraft("first owner");
  second.setDraft("second owner");

  const firstSubmit = first.submit();
  const secondSubmit = second.submit();
  posts[0]!.resolve(Response.json({ post: { ap_id: "https://social.example/ap/posts/first" } }));
  await firstSubmit;
  expect(second.getState()).toMatchObject({ content: "second owner", sending: true });
  posts[1]!.resolve(Response.json({ post: { ap_id: "https://social.example/ap/posts/second" } }));
  await secondSubmit;
  expect(first.getState().content).toBe("");
  expect(second.getState().content).toBe("");
});

test("an inactive pending ACK and a disposed pending ACK have no effects", async () => {
  const inactivePost = deferred<Response>();
  const disposedPost = deferred<Response>();
  const requests: Array<{ authorization: string; body?: unknown }> = [];
  const changes: number[] = [];
  let active = true;
  let refreshes = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ authorization, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }) });
    return requests.length === 1 ? inactivePost.promise : disposedPost.promise;
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: async () => { refreshes += 1; },
    onChange: () => changes.push(1),
    isActive: () => active,
  });

  controller.setDraft("inactive post");
  const inactiveSubmit = controller.submit();
  const changesBeforeInactiveAck = changes.length;
  active = false;
  inactivePost.resolve(Response.json({ post: { ap_id: "https://social.example/ap/posts/inactive" } }));
  await inactiveSubmit;
  expect(controller.getState().content).toBe("inactive post");
  expect(changes).toHaveLength(changesBeforeInactiveAck);
  expect(refreshes).toBe(0);

  const disposedController = createFeedController({
    session,
    refreshHome: async () => { refreshes += 1; },
    onChange: () => changes.push(2),
  });
  disposedController.setDraft("disposed post");
  const disposedSubmit = disposedController.submit();
  const changesBeforeDispose = changes.length;
  disposedController.dispose();
  disposedPost.resolve(Response.json({ post: { ap_id: "https://social.example/ap/posts/disposed" } }));
  await disposedSubmit;
  expect(changes).toHaveLength(changesBeforeDispose);
  expect(refreshes).toBe(0);
  expect(requests).toHaveLength(2);
});
