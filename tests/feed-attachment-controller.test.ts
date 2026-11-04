import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { createFeedController } from "../src/feed-controller.ts";

const session: MobileSession = {
  hostUrl: "https://social.example",
  product: "yurucommu",
  accessToken: "fixture-a",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
const file = (name = "写真.png") =>
  new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
const media = (id = "a") => ({
  r2_key: `uploads/${id.repeat(32)}.png`,
  url: `/media/${id.repeat(32)}.png`,
  content_type: "image/png",
  expires_at: "2099-01-01T00:00:00Z",
});
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("selected files upload serially and only acknowledged files can be posted", async () => {
  const first = deferred<Response>(),
    entered = deferred<void>();
  const requests: string[] = [],
    bodies: unknown[] = [];
  let uploads = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture-a",
    );
    if (path === "/api/media/upload") {
      uploads++;
      if (uploads === 1) {
        entered.resolve();
        return first.promise;
      }
      return Response.json(media("b"));
    }
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      post: { ap_id: "https://social.example/ap/posts/one" },
    });
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: async () => {},
  });
  controller.setDraft("caption");
  const pending = controller.addFiles([file("一枚目.png"), file("二枚目.png")]);
  await entered.promise;
  expect(controller.getState().attachments.map((x) => x.phase)).toEqual([
    "uploading",
    "queued",
  ]);
  await controller.submit();
  expect(bodies).toHaveLength(0);
  expect(uploads).toBe(1);
  first.resolve(Response.json(media()));
  await pending;
  expect(controller.getState().canSubmit).toBe(true);
  await controller.submit();
  expect(bodies).toEqual([
    {
      content: "caption",
      visibility: "public",
      attachments: [
        {
          url: media().url,
          r2_key: media().r2_key,
          content_type: "image/png",
          name: "一枚目.png",
        },
        {
          url: media("b").url,
          r2_key: media("b").r2_key,
          content_type: "image/png",
          name: "二枚目.png",
        },
      ],
    },
  ]);
  expect(controller.getState()).toMatchObject({
    content: "",
    attachments: [],
    sending: false,
  });
  expect(requests).toEqual([
    "/api/media/upload",
    "/api/media/upload",
    "/api/posts",
  ]);
  controller.dispose();
});

test("new text and files survive an older accepted post without reusing its media", async () => {
  const post = deferred<Response>(),
    posting = deferred<void>();
  let uploads = 0;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/api/media/upload"))
      return Response.json(media(++uploads === 1 ? "a" : "b"));
    posting.resolve();
    return post.promise;
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: async () => {},
  });
  controller.setDraft("old caption");
  await controller.addFiles([file("old.png")]);
  const oldPreview = controller.getState().attachments[0]!.previewUrl;
  const pending = controller.submit();
  await posting.promise;
  controller.setDraft("new caption");
  await controller.addFiles([file("new.png")]);
  post.resolve(
    Response.json({ post: { ap_id: "https://social.example/ap/posts/one" } }),
  );
  await pending;
  expect(controller.getState().content).toBe("new caption");
  expect(controller.getState().attachments.map((x) => x.name)).toEqual([
    "new.png",
  ]);
  await expect(originalFetch(oldPreview)).rejects.toThrow();
  controller.dispose();
});

test("unknown upload ACK retains the file and draft until an explicit retry or removal", async () => {
  let calls = 0;
  globalThis.fetch = (async () =>
    ++calls === 1
      ? Response.json({})
      : Response.json(media())) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: async () => {},
  });
  controller.setDraft("keep caption");
  await controller.addFiles([file()]);
  const attachment = controller.getState().attachments[0]!;
  expect(attachment.phase).toBe("error");
  expect(controller.getState().canSubmit).toBe(false);
  await controller.submit();
  expect(calls).toBe(1);
  expect(controller.getState().content).toBe("keep caption");
  await controller.retryAttachment(attachment.id);
  expect(calls).toBe(2);
  expect(controller.getState().attachments[0]?.phase).toBe("ready");
  controller.removeAttachment(attachment.id);
  expect(controller.getState().content).toBe("keep caption");
  await expect(originalFetch(attachment.previewUrl)).rejects.toThrow();
  controller.dispose();
});

test("an old account's late upload cannot join a new account's draft", async () => {
  const old = deferred<Response>(),
    entered = deferred<void>();
  const auth: (string | null)[] = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    if (auth.length === 1) {
      entered.resolve();
      return old.promise;
    }
    return Response.json(media("b"));
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: async () => {},
  });
  const pending = controller.addFiles([file("A.png")]);
  await entered.promise;
  const preview = controller.getState().attachments[0]!.previewUrl;
  controller.updateSession({ ...session, accessToken: "fixture-b" });
  controller.setDraft("B caption");
  await controller.addFiles([file("B.png")]);
  old.resolve(Response.json(media("a")));
  await pending;
  expect(auth).toEqual(["Bearer fixture-a", "Bearer fixture-b"]);
  expect(controller.getState().attachments.map((x) => x.name)).toEqual([
    "B.png",
  ]);
  expect(controller.getState().content).toBe("B caption");
  await expect(originalFetch(preview)).rejects.toThrow();
  controller.dispose();
});

for (const action of ["remove", "clear", "dispose"] as const) {
  test(`${action} retires a pending upload, its preview and its late acknowledgement`, async () => {
    const reply = deferred<Response>(),
      entered = deferred<void>();
    let signal: AbortSignal | undefined;
    let emissions = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      entered.resolve();
      return reply.promise;
    }) as unknown as typeof fetch;
    const controller = createFeedController({
      session,
      refreshHome: async () => {},
      onChange: () => {
        emissions++;
      },
    });
    controller.setDraft("caption");
    const pending = controller.addFiles([file()]);
    await entered.promise;
    const item = controller.getState().attachments[0]!;
    if (action === "remove") controller.removeAttachment(item.id);
    else if (action === "clear") controller.clearDraft();
    else controller.dispose();
    const beforeLate = emissions;
    expect(signal?.aborted).toBe(true);
    reply.resolve(Response.json(media()));
    await pending;
    expect(controller.getState().attachments).toEqual([]);
    if (action === "dispose") expect(emissions).toBe(beforeLate);
    if (action === "clear") expect(controller.getState().content).toBe("");
    await expect(originalFetch(item.previewUrl)).rejects.toThrow();
    controller.dispose();
  });
}

test("unknown post ACK preserves the acknowledged media and does not repeat either mutation", async () => {
  let uploads = 0,
    posts = 0;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/api/media/upload")) {
      uploads++;
      return Response.json(media());
    }
    posts++;
    return Response.json({ post: { ap_id: "" } });
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: async () => {},
  });
  controller.setDraft("keep caption");
  await controller.addFiles([file()]);
  await controller.submit();
  expect(controller.getState().content).toBe("keep caption");
  expect(controller.getState().attachments[0]?.phase).toBe("ready");
  expect(controller.getState().error).toContain("再送する前に");
  expect({ uploads, posts }).toEqual({ uploads: 1, posts: 1 });
  controller.dispose();
});

test("an acknowledged but expired staged file is rejected before posting", async () => {
  const now = Date.now;
  const expires = now() + 60_000;
  let posts = 0;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/api/media/upload"))
      return Response.json({
        ...media(),
        expires_at: new Date(expires).toISOString(),
      });
    posts++;
    return Response.json({ post: { ap_id: "unexpected" } });
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: async () => {},
  });
  try {
    controller.setDraft("caption");
    await controller.addFiles([file()]);
    Date.now = () => expires + 1;
    await controller.submit();
    expect(controller.getState().attachments[0]?.error).toContain("有効期限");
    expect(controller.getState().canSubmit).toBe(false);
    expect(posts).toBe(0);
  } finally {
    Date.now = now;
    controller.dispose();
  }
});

test("caption and current producer count limit stay authoritative before mutations", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json(media());
  }) as unknown as typeof fetch;
  const controller = createFeedController({
    session,
    refreshHome: async () => {},
  });
  await controller.addFiles([file()]);
  await controller.submit();
  expect(calls).toBe(1); // Core requires a caption.
  await controller.addFiles(Array.from({ length: 8 }, () => file()));
  expect(controller.getState().attachmentError).toContain("8件");
  expect(calls).toBe(1);
  controller.dispose();
});
