import { afterEach, expect, test } from "bun:test";
import {
  createPost,
  createYurucommuMobileTransport,
  loadHome,
  loadYurucommuMobileBookmarksPage,
} from "../src/api.ts";
import type { MobileSession } from "@takosjp/mobile-kit";
import { getYurucommuApiTransport } from "@takosjp/yurucommu-api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const session: MobileSession = {
  hostUrl: "https://social.example",
  product: "yurucommu",
  accessToken: "host-session",
  tokenType: "Bearer",
  createdAt: "2026-07-16T00:00:00.000Z",
};

const validActor = {
  ap_id: "https://social.example/ap/users/tako",
  username: "tako@social.example",
  preferred_username: "tako",
  name: "Tako",
  summary: null,
  icon_url: null,
  header_url: null,
  follower_count: 0,
  following_count: 0,
  post_count: 0,
  created_at: "2026-10-04T00:00:00Z",
};

const remotePost = {
  ap_id: "https://peer.example/ap/posts/remote-1",
  type: "Note",
  author: {
    ap_id: "https://peer.example/ap/users/remote",
    username: "remote@peer.example",
    preferred_username: null,
    name: null,
    icon_url: null,
  },
  content: "Hello from a remote peer",
  summary: null,
  attachments: [],
  in_reply_to: null,
  visibility: "public",
  community_ap_id: null,
  like_count: 0,
  reply_count: 0,
  announce_count: 0,
  published: null,
  edited_at: null,
  liked: false,
  bookmarked: false,
  reposted: false,
};

function mockHomeResponses(input: {
  actor?: unknown;
  authStatus?: number;
  timeline?: unknown;
  timelineStatus?: number;
  unread?: unknown;
} = {}) {
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const path = new URL(String(request)).pathname;
    if (path === "/api/auth/me") {
      return Response.json(
        { actor: input.actor === undefined ? validActor : input.actor },
        { status: input.authStatus ?? 200 },
      );
    }
    if (path === "/api/timeline") {
      return Response.json(
        input.timeline === undefined ? { posts: [] } : input.timeline,
        { status: input.timelineStatus ?? 200 },
      );
    }
    return Response.json(input.unread ?? { count: 0 });
  }) as unknown as typeof fetch;
}

function mockBookmarks(payload: unknown) {
  globalThis.fetch = (async () => Response.json(payload)) as unknown as typeof fetch;
}

test("home requests use the host bearer", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer host-session",
    );
    if (url.pathname === "/api/auth/me")
      return Response.json({
        actor: {
          ap_id: "a",
          preferred_username: "tako",
          name: "Tako",
          icon_url: null,
        },
      });
    if (url.pathname === "/api/timeline") return Response.json({ posts: [] });
    return Response.json({ count: 1 });
  }) as unknown as typeof fetch;
  const home = await loadHome(session);
  expect(urls.sort()).toEqual([
    "https://social.example/api/auth/me",
    "https://social.example/api/notifications/unread/count",
    "https://social.example/api/timeline?limit=20",
  ]);
  expect(home.unread).toBe(1);
  expect(getYurucommuApiTransport().resolveUrl("/api/auth/me")).toBe(
    "/api/auth/me",
  );
});

test("post creation keeps the selected visibility", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://social.example/api/posts");
    expect(init?.method).toBe("POST");
    expect(await new Response(init?.body).json()).toEqual({
      content: "hello",
      visibility: "followers",
    });
    return Response.json({
      post: {
        ap_id: "https://social.example/ap/posts/1",
        author: {
          ap_id: "https://social.example/ap/users/tako",
          preferred_username: "tako",
        },
      },
    });
  }) as unknown as typeof fetch;
  await createPost(session, "hello", "followers");
});

test("post creation requires a successful acknowledgment with a post ID", async () => {
  for (const post of [{}, { ap_id: "" }, { ap_id: 3 }]) {
    globalThis.fetch = (async () => Response.json({ post })) as unknown as typeof fetch;
    await expect(createPost(session, "keep this draft")).rejects.toThrow();
  }
});

test("bookmarks use the public Yurucommu API route", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(
      "https://social.example/api/bookmarks?limit=8",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer host-session",
    );
    return Response.json({ posts: [] });
  }) as unknown as typeof fetch;

  await expect(loadYurucommuMobileBookmarksPage(session)).resolves.toEqual([]);
});

test("home does not turn an unread-count failure into zero", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/me") {
      return Response.json({
        actor: {
          ap_id: "a",
          preferred_username: "tako",
          name: "Tako",
          icon_url: null,
        },
      });
    }
    if (url.pathname === "/api/timeline") return Response.json({ posts: [] });
    return Response.json(
      { error: "Unread count unavailable" },
      { status: 503 },
    );
  }) as unknown as typeof fetch;

  await expect(loadHome(session)).rejects.toThrow("Unread count unavailable");
});

test("bookmarks do not turn an API failure into an empty page", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: "Bookmarks unavailable" },
      { status: 503 },
    )) as unknown as typeof fetch;

  await expect(loadYurucommuMobileBookmarksPage(session)).rejects.toThrow(
    "Bookmarks unavailable",
  );
});

test("the Yurucommu transport rejects cross-origin API paths", () => {
  expect(() =>
    createYurucommuMobileTransport(session).resolveUrl(
      "https://evil.example/api",
    ),
  ).toThrow("must stay on the connected host");
});

test("empty home, feed, bookmarks, and unread count are valid", async () => {
  mockHomeResponses();
  await expect(loadHome(session)).resolves.toMatchObject({
    actor: validActor,
    posts: [],
    unread: 0,
  });
  mockBookmarks({ posts: [] });
  await expect(loadYurucommuMobileBookmarksPage(session)).resolves.toEqual([]);
});

test("2xx malformed timeline envelopes do not become an empty feed", async () => {
  for (const timeline of [{}, { posts: null }, { posts: {} }]) {
    mockHomeResponses({ timeline });
    await expect(loadHome(session)).rejects.toThrow();
  }
  for (const payload of [{}, { posts: null }, { posts: {} }]) {
    mockBookmarks(payload);
    await expect(loadYurucommuMobileBookmarksPage(session)).rejects.toThrow();
  }
});

test("home rejects malformed current actors", async () => {
  for (const actor of [
    null,
    {},
    { ...validActor, ap_id: "" },
    { ...validActor, preferred_username: 3 },
    { ...validActor, name: 3 },
    { ...validActor, icon_url: 3 },
  ]) {
    mockHomeResponses({ actor });
    await expect(loadHome(session)).rejects.toThrow();
  }
});

test("2xx missing and nonobject auth envelopes are invalid instead of unauthorized", async () => {
  for (const value of [{}, { actor: null }, null, [], "invalid"]) {
    mockHomeResponses();
    const read = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/auth/me") return Response.json(value);
      return read(input, init);
    }) as typeof fetch;
    await expect(loadHome(session)).rejects.toThrow("current-user response is invalid");
  }
});

test("home keeps non-OK auth and timeline responses as errors and unauthorized auth distinct", async () => {
  mockHomeResponses({ authStatus: 503 });
  await expect(loadHome(session)).rejects.toThrow();
  mockHomeResponses({ timelineStatus: 503 });
  await expect(loadHome(session)).rejects.toThrow("Failed to load timeline");
  mockHomeResponses({ authStatus: 401 });
  await expect(loadHome(session)).rejects.toThrow("no longer authorized");
});

test("valid remote posts retain nullable profile fields and absent published time", async () => {
  mockHomeResponses({ timeline: { posts: [remotePost] } });
  const home = await loadHome(session);
  expect(home.posts).toHaveLength(1);
  expect(home.posts[0]).toMatchObject({
    ap_id: remotePost.ap_id,
    published: null,
    author: {
      ap_id: remotePost.author.ap_id,
      username: "remote@peer.example",
      preferred_username: "remote",
      name: null,
      icon_url: null,
    },
  });
  expect(home.posts[0]?.published).toBeNull();

  mockBookmarks({ posts: [remotePost] });
  const bookmarks = await loadYurucommuMobileBookmarksPage(session);
  expect(bookmarks[0]).toMatchObject({
    published: null,
    author: {
      username: "remote@peer.example",
      preferred_username: "remote",
      name: null,
      icon_url: null,
    },
  });
});

test("invalid consumed post fields and unread counters reject on both read surfaces", async () => {
  const malformedPosts = [
    { ...remotePost, ap_id: "" },
    { ...remotePost, content: 3 },
    { ...remotePost, like_count: -1 },
    { ...remotePost, reply_count: "0" },
    { ...remotePost, author: { ...remotePost.author, ap_id: "" } },
    { ...remotePost, author: { ...remotePost.author, name: 3 } },
    { ...remotePost, author: { ...remotePost.author, icon_url: 3 } },
  ];
  for (const post of malformedPosts) {
    mockHomeResponses({ timeline: { posts: [post] } });
    await expect(loadHome(session)).rejects.toThrow();
    mockBookmarks({ posts: [post] });
    await expect(loadYurucommuMobileBookmarksPage(session)).rejects.toThrow();
  }
  for (const unread of [{}, { count: -1 }, { count: 1.5 }, { count: "0" }]) {
    mockHomeResponses({ unread });
    await expect(loadHome(session)).rejects.toThrow();
  }
});
