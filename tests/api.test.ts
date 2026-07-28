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
