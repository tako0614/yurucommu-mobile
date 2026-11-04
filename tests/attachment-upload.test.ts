import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import type { MediaAttachment } from "@takosjp/yurucommu-api";
import {
  createPost,
  uploadPostMedia,
  validateMobileUpload,
} from "../src/api.ts";
import {
  getYurucommuApiTransport,
  maxImageFileSize,
} from "@takosjp/yurucommu-api";

const session: MobileSession = {
  hostUrl: "https://social.example",
  product: "yurucommu",
  accessToken: "fixture-upload-account",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
const media = {
  r2_key: "uploads/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
  url: "/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
  content_type: "image/png",
  name: "旅行の写真.png",
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a composed post sends its acknowledged attachment through the selected account", async () => {
  let body: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://social.example/api/posts");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture-upload-account",
    );
    body = JSON.parse(String(init?.body));
    return Response.json({
      post: { ap_id: "https://social.example/ap/posts/accepted" },
    });
  }) as unknown as typeof fetch;
  const postWithMedia: (
    selected: MobileSession,
    content: string,
    visibility: "followers",
    attachments: readonly MediaAttachment[],
  ) => Promise<void> = createPost;
  await postWithMedia(session, "旅の写真です", "followers", [media]);
  expect(body).toEqual({
    content: "旅の写真です",
    visibility: "followers",
    attachments: [media],
  });
});

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const file = () => new File([png], "旅行の写真.png", { type: "image/png" });

test("multipart upload reuses SDK validation and account transport without rejecting a Unicode basename", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://social.example/api/media/upload");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture-upload-account",
    );
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("content-type")).toBeNull();
    const uploaded = (init?.body as FormData).get("file") as File;
    expect(uploaded.name).toBe("attachment.png");
    expect(uploaded.type).toBe("image/png");
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(png);
    return Response.json({ ...media, expires_at: "2099-01-01T00:00:00Z" });
  }) as unknown as typeof fetch;
  const selectedFile = file();
  expect(
    await uploadPostMedia(session, selectedFile, new AbortController().signal),
  ).toEqual({ ...media, expiresAt: "2099-01-01T00:00:00Z" });
  expect(selectedFile.name).toBe("旅行の写真.png");
  expect(getYurucommuApiTransport().resolveUrl("/api/media/upload")).toBe(
    "/api/media/upload",
  );
});

test("invalid files and an already cancelled upload never start a request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json(media);
  }) as unknown as typeof fetch;
  for (const invalid of [
    new File([], "empty.png", { type: "image/png" }),
    new File(["svg"], "a.svg", { type: "image/svg+xml" }),
    new File([new Uint8Array(maxImageFileSize + 1)], "big.png", {
      type: "image/png",
    }),
  ]) {
    expect(() => validateMobileUpload(invalid)).toThrow();
    await expect(
      uploadPostMedia(session, invalid, new AbortController().signal),
    ).rejects.toThrow();
  }
  const cancelled = new AbortController();
  cancelled.abort(new Error("fixture cancelled"));
  await expect(
    uploadPostMedia(session, file(), cancelled.signal),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("malformed or foreign upload ACKs never become post attachments", async () => {
  for (const value of [
    {},
    { ...media, r2_key: "uploads/../other.png" },
    { ...media, content_type: "video/mp4" },
    { ...media, url: "https://foreign.example/media/a.png" },
    { ...media, expires_at: "2000-01-01T00:00:00Z" },
    { ...media, expires_at: "unknown" },
    { ...media, r2_key: null },
  ]) {
    globalThis.fetch = (async () =>
      Response.json(value)) as unknown as typeof fetch;
    await expect(
      uploadPostMedia(session, file(), new AbortController().signal),
    ).rejects.toThrow();
  }
});

test("server validation errors remain actionable and upload captures its original account before reading the file", async () => {
  const selected = { ...session };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://social.example/api/media/upload");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture-upload-account",
    );
    expect(init?.redirect).toBe("error");
    return Response.json(
      { error: "File content does not match declared type" },
      { status: 400 },
    );
  }) as unknown as typeof fetch;
  const pending = uploadPostMedia(
    selected,
    file(),
    new AbortController().signal,
  );
  selected.hostUrl = "https://other.example";
  selected.accessToken = "other-fixture-account";
  await expect(pending).rejects.toThrow(
    "File content does not match declared type",
  );
});

test("a post ACK held after actual HTTP headers remains cancellable", async () => {
  let returned!: () => void;
  const headers = new Promise<void>((done) => {
    returned = done;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.method).toBe("POST");
      expect(await request.json()).toMatchObject({ content: "caption" });
      return new Response(
        new ReadableStream<Uint8Array>({
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
  }) as typeof fetch;
  const controller = new AbortController();
  const post: (
    s: MobileSession,
    text: string,
    visibility: "public",
    attachments: readonly MediaAttachment[],
    signal: AbortSignal,
  ) => Promise<void> = createPost;
  const pending = post(
    { ...session, hostUrl: server.url.origin },
    "caption",
    "public",
    [],
    controller.signal,
  ).then(
    () => "incorrect success",
    () => "aborted",
  );
  try {
    await headers;
    await Bun.sleep(0);
    controller.abort(new Error("fixture account ended"));
    expect(
      await Promise.race([
        pending,
        Bun.sleep(500).then(() => "still reading ACK"),
      ]),
    ).toBe("aborted");
  } finally {
    server.stop(true);
    await pending;
  }
});
