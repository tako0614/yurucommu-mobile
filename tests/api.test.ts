import { afterEach, expect, test } from "bun:test";
import { createPost, loadHome } from "../src/api.ts";
import type { MobileSession } from "@takosjp/takosumi-mobile-kit";

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
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
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
    return Response.json({ notifications: [{ read: false }] });
  }) as unknown as typeof fetch;
  const home = await loadHome(session);
  expect(paths.sort()).toEqual([
    "/api/auth/me",
    "/api/notifications",
    "/api/timeline",
  ]);
  expect(home.unread).toBe(1);
});

test("post creation keeps the selected visibility", async () => {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    expect(await new Response(init?.body).json()).toEqual({
      content: "hello",
      visibility: "followers",
    });
    return Response.json({ post: {} });
  }) as unknown as typeof fetch;
  await createPost(session, "hello", "followers");
});
