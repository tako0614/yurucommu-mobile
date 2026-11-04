import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { maxImageFileSize } from "@takosjp/yurucommu-api";
import {
  createMobileMediaController,
  describeMobilePostMedia,
  loadMobileMediaBlob,
} from "../src/post-media.ts";

const session: MobileSession = {
  hostUrl: "https://social.example",
  product: "yurucommu",
  accessToken: "fixture-a",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
const attachment = {
  r2_key: "uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
  content_type: "image/png",
  name: "私有の画像",
};
const local = () => describeMobilePostMedia([attachment], session.hostUrl)[0]!;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("abort after actual HTTP headers closes a held body through the published SDK", async () => {
  let headersReturned!: () => void;
  const headers = new Promise<void>((resolve) => {
    headersReturned = resolve;
  });
  let cancelled = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new Headers(request.headers).get("authorization")).toBe(
        "Bearer fixture-a",
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "image/png" } },
      );
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    headersReturned();
    return response;
  }) as typeof fetch;
  const localSession = { ...session, hostUrl: server.url.origin };
  const source = describeMobilePostMedia(
    [attachment],
    localSession.hostUrl,
  )[0]!;
  const abort = new AbortController();
  const pending = loadMobileMediaBlob(localSession, source, abort.signal);
  const settled = pending.then(
    () => "incorrect partial success",
    () => "aborted",
  );
  try {
    await headers;
    // Cross a task boundary after real response headers, so SDK finally ran.
    await Bun.sleep(0);
    abort.abort(new Error("fixture cancelled after headers"));
    expect(
      await Promise.race([
        settled,
        Bun.sleep(500).then(() => "still reading body"),
      ]),
    ).toBe("aborted");
  } finally {
    server.stop(true);
    await settled;
  }
  // Actual HTTP was used, not a Response whose body ignores AbortSignal.
  expect(cancelled).toBe(true);
});

test("the actual inbound ActivityPub mediaType projection remains displayable", () => {
  const raw = {
    type: "Document",
    mediaType: "image/webp",
    url: "https://remote.example/photo.webp",
    name: "Remote photo",
  };
  expect(describeMobilePostMedia([raw], session.hostUrl)[0]).toEqual({
    kind: "image",
    label: "Remote photo",
    url: raw.url,
    contentType: "image/webp",
    authenticated: false,
  });
  expect(
    describeMobilePostMedia(
      [{ ...raw, content_type: "video/mp4" }],
      session.hostUrl,
    )[0]?.kind,
  ).toBe("video");
  expect(
    describeMobilePostMedia(
      [{ ...raw, content_type: { toString: null } }],
      session.hostUrl,
    )[0]?.kind,
  ).toBe("unavailable");
});

test("canonical media is resolved on the selected host, including relative URLs", () => {
  expect(local()).toEqual({
    kind: "image",
    label: "私有の画像",
    url: "https://social.example/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    contentType: "image/png",
    authenticated: true,
  });
  expect(
    describeMobilePostMedia(
      [{ ...attachment, url: "/media/cccccccccccccccccccccccccccccccc.png" }],
      session.hostUrl,
    )[0]?.url,
  ).toBe("https://social.example/media/cccccccccccccccccccccccccccccccc.png");
});

test("remote HTTPS images and video remain anonymous", () => {
  const values = describeMobilePostMedia(
    [
      { ...attachment, url: "https://cdn.example/file.png" },
      {
        r2_key: "uploads/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4",
        content_type: "video/mp4",
      },
    ],
    session.hostUrl,
  );
  expect(values[0]?.authenticated).toBe(false);
  expect(values[1]?.kind).toBe("video");
  expect(values[1]?.authenticated).toBe(true);
});

test("malformed, executable and noncanonical local attachments are visible as unavailable", () => {
  expect(describeMobilePostMedia(undefined, session.hostUrl)).toEqual([]);
  expect(describeMobilePostMedia(null, session.hostUrl)[0]?.kind).toBe(
    "unavailable",
  );
  for (const value of [
    null,
    {},
    { ...attachment, url: "javascript:alert(1)" },
    { ...attachment, url: "https://u:p@cdn.example/a" },
    { ...attachment, url: "http://cdn.example/a" },
    { ...attachment, url: "/api/auth/logout" },
    { ...attachment, url: "/media/a?access_token=x" },
    { ...attachment, url: " /media/a" },
    { ...attachment, r2_key: "uploads/../a" },
    { ...attachment, content_type: "image/svg+xml" },
    { ...attachment, content_type: { toString: null } },
  ]) {
    expect(describeMobilePostMedia([value], session.hostUrl)[0]?.kind).toBe(
      "unavailable",
    );
  }
});

test("only the canonical selected host receives auth, cookies omitted and redirects refused", async () => {
  let calls = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(String(url)).toBe(
      "https://social.example/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture-a",
    );
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    return new Response("image", { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  const blob = await loadMobileMediaBlob(
    session,
    local(),
    new AbortController().signal,
  );
  expect(await blob.text()).toBe("image");
  const remote = describeMobilePostMedia(
    [{ ...attachment, url: "https://cdn.example/file.png" }],
    session.hostUrl,
  )[0]!;
  await expect(
    loadMobileMediaBlob(session, remote, new AbortController().signal),
  ).rejects.toThrow();
  await expect(
    loadMobileMediaBlob(
      session,
      { ...remote, authenticated: true },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test("failed status, mismatched MIME, empty body and declared oversized media are not ready", async () => {
  for (const response of [
    new Response("no", { status: 403 }),
    new Response("svg", { headers: { "content-type": "image/svg+xml" } }),
    new Response("", { headers: { "content-type": "image/png" } }),
    new Response("small", {
      headers: {
        "content-type": "image/png",
        "content-length": String(maxImageFileSize + 1),
      },
    }),
  ]) {
    globalThis.fetch = (async () => response) as unknown as typeof fetch;
    await expect(
      loadMobileMediaBlob(session, local(), new AbortController().signal),
    ).rejects.toThrow();
  }
});

test("streaming cap rejects a large body even without Content-Length", async () => {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array(maxImageFileSize + 1), {
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
  await expect(
    loadMobileMediaBlob(session, local(), new AbortController().signal),
  ).rejects.toThrow("サイズ");
});

test("reads start explicitly, errors can be retried and disposal revokes the actual object URL", async () => {
  let calls = 0;
  globalThis.fetch = (async () =>
    ++calls === 1
      ? new Response("no", { status: 503 })
      : new Response("image", {
          headers: { "content-type": "image/png" },
        })) as unknown as typeof fetch;
  const controller = createMobileMediaController({ session, source: local() });
  expect(calls).toBe(0);
  await controller.load();
  expect(controller.getState().phase).toBe("error");
  await controller.load();
  expect(controller.getState().phase).toBe("ready");
  const url = controller.getState().url!;
  expect(url.startsWith("blob:")).toBe(true);
  expect(await (await originalFetch(url)).text()).toBe("image");
  controller.dispose();
  expect(controller.getState().url).toBeUndefined();
  await expect(originalFetch(url)).rejects.toThrow();
  expect(calls).toBe(2);
});

test("account switch retires a ready URL and ignores the previous account's late body", async () => {
  let resolve!: (value: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((done) => {
      resolve = done;
    })) as unknown as typeof fetch;
  const controller = createMobileMediaController({ session, source: local() });
  const pending = controller.load();
  controller.update({ ...session, accessToken: "fixture-b" }, local());
  resolve(new Response("old", { headers: { "content-type": "image/png" } }));
  await pending;
  expect(controller.getState()).toEqual({ phase: "idle" });
  globalThis.fetch = (async () =>
    new Response("new", {
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
  await controller.load();
  const url = controller.getState().url!;
  expect(await (await originalFetch(url)).text()).toBe("new");
  controller.update({ ...session, accessToken: "fixture-c" }, local());
  expect(controller.getState()).toEqual({ phase: "idle" });
  await expect(originalFetch(url)).rejects.toThrow();
  controller.dispose();
});

test("remote display never installs auth or fetches through the authenticated reader", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("unexpected");
  }) as unknown as typeof fetch;
  const source = describeMobilePostMedia(
    [{ ...attachment, url: "https://cdn.example/file.png" }],
    session.hostUrl,
  )[0]!;
  const controller = createMobileMediaController({ session, source });
  await controller.load();
  expect(controller.getState()).toEqual({ phase: "ready", url: source.url });
  expect(calls).toBe(0);
  controller.failed(source.url);
  expect(controller.getState().phase).toBe("error");
  controller.dispose();
});

test("an old element error cannot replace the current account's media state", async () => {
  globalThis.fetch = (async () =>
    new Response("image", {
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
  const controller = createMobileMediaController({ session, source: local() });
  await controller.load();
  const old = controller.getState().url;
  controller.update({ ...session, accessToken: "fixture-b" }, local());
  controller.failed(old);
  expect(controller.getState()).toEqual({ phase: "idle" });
  await controller.load();
  const current = controller.getState().url;
  controller.failed(old);
  expect(controller.getState()).toEqual({ phase: "ready", url: current });
  controller.dispose();
});
