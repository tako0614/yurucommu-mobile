import { expect, test } from "bun:test";
import * as media from "../src/post-media.ts";
test("canonical profile image has explicit image context without a made-up MIME", () => {
  const sources = (
    media as unknown as {
      describeMobileProfileImage: (
        value: unknown,
        host: string,
      ) => readonly media.MobileMediaSource[];
    }
  ).describeMobileProfileImage("/media/abc.png", "https://image.fixture.test");
  expect(sources[0]).toMatchObject({
    kind: "image",
    contentType: "image/*",
    authenticated: true,
    url: "https://image.fixture.test/media/abc.png",
  });
});

import {
  loadMobileMediaBlob,
  describeMobileProfileImage,
  describeMobilePostMedia,
} from "../src/post-media.ts";
const session = {
  product: "yurucommu" as const,
  hostUrl: "https://image.fixture.test",
  accessToken: "synthetic-profile-image",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"])
  test(`profile wildcard validates actual HTTP ${type} and assigns actual Blob MIME`, async () => {
    const calls: { path: string; auth: string | null }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        calls.push({
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
        });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": type },
        });
      },
    });
    try {
      const host = server.url.origin,
        source = describeMobileProfileImage("/media/profile.png", host)[0]!;
      const blob = await loadMobileMediaBlob(
        { ...session, hostUrl: host },
        source,
        new AbortController().signal,
      );
      expect(blob.type).toBe(type);
      expect(blob.size).toBe(3);
      expect(calls).toEqual([
        { path: "/media/profile.png", auth: "Bearer synthetic-profile-image" },
      ]);
    } finally {
      server.stop(true);
    }
  });
for (const type of ["text/html", "application/json", "image/svg+xml", ""])
  test("an undeclared or unsupported actual profile image body is rejected", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: type ? { "content-type": type } : {},
        });
      },
    });
    try {
      const host = server.url.origin;
      await expect(
        loadMobileMediaBlob(
          { ...session, hostUrl: host },
          describeMobileProfileImage("/media/profile.png", host)[0]!,
          new AbortController().signal,
        ),
      ).rejects.toThrow("形式");
    } finally {
      server.stop(true);
    }
  });
test("ordinary post attachment MIME remains exact and cannot opt into profile wildcard", async () => {
  const host = session.hostUrl;
  expect(
    describeMobilePostMedia(
      [{ url: "/media/profile.png", content_type: "image/*" }],
      host,
    )[0]?.kind,
  ).toBe("unavailable");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(new Uint8Array([1]), {
        headers: { "content-type": "image/jpeg" },
      });
    },
  });
  try {
    const host = server.url.origin,
      source = describeMobilePostMedia(
        [{ url: "/media/profile.png", content_type: "image/png" }],
        host,
      )[0]!;
    await expect(
      loadMobileMediaBlob(
        { ...session, hostUrl: host },
        source,
        new AbortController().signal,
      ),
    ).rejects.toThrow("形式");
  } finally {
    server.stop(true);
  }
});
for (const value of [
  "javascript:alert(1)",
  "https://user:secret@example.test/x.png",
  "/api/auth/me",
  "/media/x.png?token=synthetic",
  "/media/x.png#fragment",
  "http://remote.example/x.png",
])
  test("profile URL cannot obtain credential authority outside canonical selected media", () => {
    expect(describeMobileProfileImage(value, session.hostUrl)[0]?.kind).toBe(
      "unavailable",
    );
  });
test("public remote profile image remains an unauthenticated browser image", async () => {
  const source = describeMobileProfileImage(
    "https://remote.example/avatar",
    session.hostUrl,
  )[0]!;
  expect(source).toMatchObject({ kind: "image", authenticated: false });
  await expect(
    loadMobileMediaBlob(session, source, new AbortController().signal),
  ).rejects.toThrow("認証付き");
});
test("aborting a profile image body after headers rejects rather than publishing bytes", async () => {
  let headers = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch() {
      headers = true;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1]));
          },
        }),
        { headers: { "content-type": "image/png" } },
      );
    },
  });
  const abort = new AbortController();
  try {
    const host = server.url.origin,
      result = loadMobileMediaBlob(
        { ...session, hostUrl: host },
        describeMobileProfileImage("/media/slow.png", host)[0]!,
        abort.signal,
      );
    for (const end = Date.now() + 1000; !headers && Date.now() < end;)
      await Bun.sleep(1);
    expect(headers).toBe(true);
    await Bun.sleep(10);
    abort.abort(Error("retired image owner"));
    await expect(result).rejects.toThrow();
  } finally {
    server.stop(true);
  }
});
