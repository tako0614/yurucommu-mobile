import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { createPost } from "../src/api.ts";
import { createFeedController } from "../src/feed-controller.ts";
import { createNotificationController } from "../src/notification-controller.ts";
import {
  loadMobilePostReplies,
  loadMobileNotificationPost,
} from "../src/notification-api.ts";

const originalFetch = globalThis.fetch;
const stops: (() => void)[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  stops.splice(0).forEach((stop) => stop());
});
const session: MobileSession = {
  product: "yurucommu",
  hostUrl: "https://a.social.example",
  accessToken: "synthetic-conversation-a",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
const parent = "https://remote.example/ap/posts/parent?part=1&value=x";
const child = "https://a.social.example/ap/posts/reply";
const actor = {
  ap_id: "https://a.social.example/ap/users/owner",
  preferred_username: "owner",
  username: "owner@a.social.example",
  name: "Owner",
  icon_url: null,
};
const note = (id: string, extra: Record<string, unknown> = {}) => ({
  ap_id: id,
  type: "Note",
  author: actor,
  content: "Actual note",
  published: null,
  visibility: "public",
  community_ap_id: null,
  in_reply_to: null,
  like_count: 0,
  reply_count: 0,
  attachments: [],
  bookmarked: false,
  ...extra,
});
const page = (rows: unknown[] = [], cursor: string | null = null) =>
  Response.json({
    replies: rows,
    has_more: cursor !== null,
    next_cursor: cursor,
  });
type Request = {
  url: string;
  init?: RequestInit;
  method: string;
  resolve: (value: Response) => void;
};
function fixture() {
  const requests: Request[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) =>
      requests.push({
        url: String(input),
        init,
        method: init?.method ?? "GET",
        resolve,
      }),
    )) as typeof fetch;
  return requests;
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 1000;
  while (!predicate() && Date.now() < end) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}
async function resolveCurrentActor(requests: Request[], start = 0) {
  expect(new URL(requests[start]!.url).pathname).toBe("/api/auth/me");
  requests[start]!.resolve(
    Response.json({
      actor: {
        ...actor,
        ap_id: "https://a.social.example/ap/users/replier",
        preferred_username: "replier",
      },
    }),
  );
  await until(() => requests.length === start + 2);
}
async function open(
  c: ReturnType<typeof createNotificationController>,
  requests: Request[],
  extra: Record<string, unknown> = {},
  first = page(),
) {
  const start = requests.length,
    pending = c.openPost(parent);
  requests[start]!.resolve(Response.json({ post: note(parent, extra) }));
  await pending;
  const replies = c.reloadReplies();
  requests[start + 1]!.resolve(first);
  await replies;
  await until(() => !c.getState().repliesLoading);
}
function accepted() {
  return Response.json({
    post: { ap_id: child, author: actor, visibility: "public" },
  });
}
function saved(extra: Record<string, unknown> = {}) {
  return Response.json({
    post: note(child, { in_reply_to: parent, ...extra }),
  });
}

test("reply reads bind every raw row to the encoded selected-host parent and preserve a valid empty continuation", async () => {
  const requests = fixture();
  const pending = loadMobilePostReplies(session, parent, "opaque + cursor");
  expect(requests[0]!.url).toBe(
    `${session.hostUrl}/api/posts/${encodeURIComponent(parent)}/replies?limit=20&before=opaque+%2B+cursor`,
  );
  expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe(
    "Bearer synthetic-conversation-a",
  );
  expect(requests[0]!.init).toMatchObject({
    credentials: "omit",
    redirect: "error",
  });
  requests[0]!.resolve(page([], "next"));
  expect(await pending).toEqual({
    replies: [],
    hasMore: true,
    nextCursor: "next",
  });
});

for (const payload of [
  { replies: null, has_more: false },
  { replies: [], has_more: true },
  {
    replies: [note(child, { in_reply_to: "another-parent" })],
    has_more: false,
  },
  {
    replies: [note(child, { in_reply_to: parent, published: undefined })],
    has_more: false,
  },
  {
    replies: [note(child, { in_reply_to: parent, author: null })],
    has_more: false,
  },
]) {
  test("malformed or unrelated reply data is an error, never an empty conversation", async () => {
    const requests = fixture(),
      pending = loadMobilePostReplies(session, parent);
    requests[0]!.resolve(Response.json(payload));
    await expect(pending).rejects.toThrow();
  });
}

test("failed continuation retries its actual cursor, deduplicates rows and refuses cursor cycles", async () => {
  const requests = fixture(),
    c = createNotificationController({ session });
  await open(c, requests, {}, page([], "cursor-a"));
  expect(c.getState()).toMatchObject({
    repliesLoaded: true,
    replies: [],
    repliesHasMore: true,
  });
  let pending = c.loadMoreReplies();
  requests[2]!.resolve(new Response("unavailable", { status: 503 }));
  await pending;
  expect(c.getState().repliesCursor).toBe("cursor-a");
  expect(requests).toHaveLength(3);
  pending = c.retryReplies();
  expect(new URL(requests[3]!.url).searchParams.get("before")).toBe("cursor-a");
  requests[3]!.resolve(
    page(
      [
        note(child, { in_reply_to: parent }),
        note(child, { in_reply_to: parent }),
      ],
      "cursor-b",
    ),
  );
  await pending;
  expect(c.getState().replies).toHaveLength(1);
  pending = c.loadMoreReplies();
  requests[4]!.resolve(page([], "cursor-a"));
  await pending;
  expect(c.getState().repliesError).not.toBe("");
  expect(c.getState().repliesCursor).toBe("cursor-b");
  expect(c.getState().replies).toHaveLength(1);
  c.dispose();
});

test("conversation Back restores its loaded rows and cursor instead of losing the continuation", async () => {
  const requests = fixture(),
    c = createNotificationController({ session });
  await open(
    c,
    requests,
    {},
    page([note(child, { in_reply_to: parent })], "parent-next"),
  );
  const enter = c.openReply(child);
  requests[2]!.resolve(
    Response.json({ post: note(child, { in_reply_to: parent }) }),
  );
  await enter;
  const childReplies = c.reloadReplies();
  requests[3]!.resolve(page());
  await childReplies;
  await until(() => !c.getState().repliesLoading);
  const back = c.back();
  requests[4]!.resolve(Response.json({ post: note(parent) }));
  await back;
  expect(c.getState()).toMatchObject({
    post: { ap_id: parent },
    repliesCursor: "parent-next",
    repliesHasMore: true,
  });
  expect(c.getState().replies.map((post) => post.ap_id)).toEqual([child]);
  expect(requests).toHaveLength(5);
  c.dispose();
});

test("Back retains a reply draft; rejecting a different target causes no request or silent discard", async () => {
  const requests = fixture();
  let allow = false,
    confirms = 0;
  const c = createNotificationController({
    session,
    confirmDiscardReply: () => {
      confirms++;
      return allow;
    },
  });
  await open(c, requests);
  c.getReplyComposer()!.setDraft("keep reply");
  c.back();
  expect(c.getState().page).toBe("home");
  await c.openPost("another");
  expect(confirms).toBe(1);
  expect(requests).toHaveLength(2);
  await open(c, requests);
  expect(c.getState().replyDraft?.content).toBe("keep reply");
  allow = true;
  const next = c.openReply(child);
  await until(() => requests.length === 5);
  requests[4]!.resolve(
    Response.json({ post: note(child, { in_reply_to: parent }) }),
  );
  await next;
  const nextReplies = c.reloadReplies();
  requests[5]!.resolve(page());
  await nextReplies;
  await until(() => !c.getState().repliesLoading);
  expect(c.getState().replyDraft?.content).toBe("");
  c.dispose();
});

test("an ACK/readback confirms exact parent/author/audience while preserving a newer reply draft", async () => {
  const requests = fixture();
  let home = 0;
  const c = createNotificationController({
    session,
    onPostReplied: async () => {
      home++;
    },
  });
  await open(c, requests);
  const composer = c.getReplyComposer()!;
  composer.setDraft("first reply");
  const sending = composer.submit();
  composer.setDraft("next reply");
  const body = JSON.parse(String(requests[2]!.init?.body));
  expect(body).toMatchObject({
    content: "first reply",
    visibility: "public",
    in_reply_to: parent,
  });
  requests[2]!.resolve(accepted());
  await until(() => requests.length === 4);
  expect(requests[3]!.url).toBe(
    `${session.hostUrl}/api/posts/${encodeURIComponent(child)}`,
  );
  requests[3]!.resolve(saved());
  await until(() => requests.length === 5);
  requests[4]!.resolve(page([note(child, { in_reply_to: parent })]));
  await sending;
  expect(c.getState().replyDraft).toMatchObject({
    content: "next reply",
    sending: false,
    status: "返信を投稿しました。",
  });
  expect(c.getState().replies.map((post) => post.ap_id)).toEqual([child]);
  expect(home).toBe(1);
  expect(requests.filter((req) => req.method === "POST")).toHaveLength(1);
  c.dispose();
});

for (const mismatch of [
  { ap_id: "another-post" },
  { in_reply_to: "another" },
  { visibility: "public" },
  { community_ap_id: null },
  { author: { ap_id: "other-actor" } },
]) {
  test("a mismatched persisted reply remains an unknown outcome with its draft protected", async () => {
    const requests = fixture();
    const community = "https://a.social.example/communities/private";
    const composer = createFeedController({
      session,
      replyTo: {
        apId: parent,
        visibility: "followers",
        communityApId: community,
      },
      refreshHome: async () => {},
    });
    composer.setVisibility("followers");
    composer.setDraft("protected reply");
    const pending = composer.submit();
    expect(JSON.parse(String(requests[0]!.init?.body))).toMatchObject({
      in_reply_to: parent,
      visibility: "followers",
      community_ap_id: community,
    });
    requests[0]!.resolve(accepted());
    await until(() => requests.length === 2);
    requests[1]!.resolve(
      saved({
        visibility: "followers",
        community_ap_id: community,
        ...mismatch,
      }),
    );
    await pending;
    expect(composer.getState()).toMatchObject({
      content: "protected reply",
      sending: false,
      status: "",
    });
    expect(composer.getState().error).not.toBe("");
    expect(requests.filter((req) => req.method === "POST")).toHaveLength(1);
    composer.dispose();
  });
}

test("direct replies require an explicit mention and cannot silently become public", async () => {
  const requests = fixture();
  const composer = createFeedController({
    session,
    replyTo: { apId: parent, visibility: "direct", communityApId: null },
    refreshHome: async () => {},
  });
  composer.setDraft("no recipient");
  composer.setVisibility("public");
  expect(composer.getState().visibility).toBe("direct");
  await composer.submit();
  expect(requests).toHaveLength(0);
  composer.setDraft("@owner@a.social.example explicit reply");
  const pending = composer.submit();
  await resolveCurrentActor(requests);
  requests[1]!.resolve(Response.json({ actor }));
  await until(() => requests.length === 3);
  expect(JSON.parse(String(requests[2]!.init?.body))).toMatchObject({
    visibility: "direct",
    in_reply_to: parent,
  });
  requests[2]!.resolve(accepted());
  await until(() => requests.length === 4);
  requests[3]!.resolve(saved({ visibility: "direct" }));
  await pending;
  expect(composer.getState().status).toBe("返信を投稿しました。");
  composer.dispose();
});

test("failed mention processing is not presented as a delivered reply and never auto-retries", async () => {
  const requests = fixture();
  const composer = createFeedController({
    session,
    replyTo: { apId: parent, visibility: "direct", communityApId: null },
    refreshHome: async () => {},
  });
  composer.setDraft("@missing@remote.example explicit reply");
  const pending = composer.submit();
  await resolveCurrentActor(requests);
  requests[1]!.resolve(
    Response.json({
      actor: {
        ...actor,
        ap_id: "https://remote.example/ap/users/missing",
        preferred_username: "missing",
      },
    }),
  );
  await until(() => requests.length === 3);
  requests[2]!.resolve(
    Response.json({
      post: {
        ap_id: child,
        author: actor,
        mention_processing: { failed_count: 1 },
      },
    }),
  );
  await pending;
  expect(composer.getState().content).toContain("@missing");
  expect(composer.getState().status).toBe("");
  expect(composer.getState().error).toContain("宛先");
  expect(requests).toHaveLength(3);
  composer.dispose();
});

for (const transition of ["back", "session", "dispose"] as const) {
  test(`${transition} cancels pending reply work and fences late data`, async () => {
    const requests = fixture(),
      c = createNotificationController({ session });
    await open(c, requests);
    const composer = c.getReplyComposer()!;
    composer.setDraft("pending reply");
    const pending = composer.submit();
    if (transition === "back") c.back();
    if (transition === "session")
      c.updateSession({ ...session, accessToken: "synthetic-conversation-b" });
    if (transition === "dispose") c.dispose();
    expect(requests[2]!.init?.signal?.aborted).toBe(true);
    requests[2]!.resolve(accepted());
    await pending;
    expect(c.getState().page).toBe("home");
    expect(requests).toHaveLength(3);
    if (transition === "back")
      expect(composer.getState().content).toBe("pending reply");
    else expect(c.getReplyComposer()).toBeUndefined();
    c.dispose();
  });
}

test("an accepted reply supersedes an older reply read and cannot be hidden by its late page", async () => {
  const requests = fixture(),
    c = createNotificationController({ session });
  const detail = c.openPost(parent);
  requests[0]!.resolve(Response.json({ post: note(parent) }));
  await detail;
  const olderRead = c.reloadReplies();
  c.getReplyComposer()!.setDraft("first reply");
  const pending = c.getReplyComposer()!.submit();
  requests[2]!.resolve(accepted());
  await until(() => requests.length === 4);
  requests[3]!.resolve(saved());
  await until(() => requests.length === 5);
  expect(requests[1]!.init?.signal?.aborted).toBe(true);
  requests[4]!.resolve(page([note(child, { in_reply_to: parent })]));
  await pending;
  requests[1]!.resolve(page());
  await olderRead;
  await Bun.sleep(1);
  expect(c.getState().replies.map((post) => post.ap_id)).toEqual([child]);
  c.dispose();
});

test("unknown parent reach or community metadata never enables an inferred-public reply", async () => {
  for (const fields of [
    { type: "Story" },
    { visibility: "unexpected" },
    { community_ap_id: undefined },
  ]) {
    const requests = fixture(),
      read = loadMobileNotificationPost(session, parent);
    requests[0]!.resolve(Response.json({ post: note(parent, fields) }));
    expect((await read).replyContext).toBeNull();
  }
});

test("pre-aborted reply sends no request", async () => {
  const requests = fixture(),
    abort = new AbortController();
  abort.abort();
  await expect(
    createPost(session, "text", "public", [], abort.signal, {
      apId: parent,
      communityApId: null,
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
});

test("a personal followers reply requires an explicit audience choice and keeps it across same-context refresh", () => {
  const requests = fixture();
  const target = {
    apId: parent,
    visibility: "followers" as const,
    communityApId: null,
  };
  const composer = createFeedController({
    session,
    replyTo: target,
    refreshHome: async () => {},
  });
  composer.setDraft("reply");
  expect(composer.getState()).toMatchObject({
    canSubmit: false,
    replyAudienceNeedsChoice: true,
  });
  composer.setVisibility("public");
  expect(composer.getState().canSubmit).toBe(false);
  composer.setVisibility("followers");
  expect(composer.getState()).toMatchObject({
    canSubmit: true,
    replyAudienceNeedsChoice: false,
  });
  composer.updateReplyContext(target);
  expect(composer.getState().canSubmit).toBe(true);
  composer.setVisibility("direct");
  expect(composer.getState().canSubmit).toBe(false);
  composer.setDraft("@owner explicit reply");
  expect(composer.getState().canSubmit).toBe(true);
  expect(requests).toHaveLength(0);
  composer.dispose();
  const scoped = createFeedController({
    session,
    replyTo: {
      ...target,
      communityApId: "https://a.social.example/groups/private",
    },
    refreshHome: async () => {},
  });
  scoped.setVisibility("followers");
  scoped.setDraft("reply");
  scoped.updateSession({ ...session, accessToken: "synthetic-next-account" });
  expect(scoped.getState().replyAudienceNeedsChoice).toBe(true);
  scoped.dispose();
});

test("reply reads remain available when parent metadata is insufficient to compose", async () => {
  const requests = fixture(),
    c = createNotificationController({ session });
  const read = c.openPost(parent);
  requests[0]!.resolve(
    Response.json({ post: note(parent, { type: "Story" }) }),
  );
  await read;
  expect(c.getReplyComposer()).toBeUndefined();
  const replies = c.reloadReplies();
  requests[1]!.resolve(page([note(child, { in_reply_to: parent })]));
  await replies;
  expect(c.getState().replies.map((post) => post.ap_id)).toEqual([child]);
  c.dispose();
});

test("retiring a direct-recipient lookup cannot start a late POST", async () => {
  const requests = fixture(),
    c = createNotificationController({ session });
  await open(c, requests, { visibility: "direct" });
  c.getReplyComposer()!.setDraft("@owner@a.social.example reply");
  const pending = c.getReplyComposer()!.submit();
  await resolveCurrentActor(requests, 2);
  expect(new URL(requests[3]!.url).pathname).toContain("/api/actors/");
  c.updateSession({ ...session, accessToken: "synthetic-next-account" });
  requests[3]!.resolve(Response.json({ actor }));
  await pending;
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(
    0,
  );
  c.dispose();
});

test("unresolved direct recipients and lookalike actor hosts fail before any POST", async () => {
  for (const response of [
    new Response("missing", { status: 404 }),
    Response.json({
      actor: {
        ...actor,
        ap_id: "https://remote.example.evil/users/missing",
        preferred_username: "missing",
      },
    }),
  ]) {
    const requests = fixture();
    const composer = createFeedController({
      session,
      replyTo: { apId: parent, visibility: "direct", communityApId: null },
      refreshHome: async () => {},
    });
    composer.setDraft("@missing@remote.example reply");
    const pending = composer.submit();
    await resolveCurrentActor(requests);
    expect(requests[1]!.method).toBe("GET");
    requests[1]!.resolve(response);
    await pending;
    expect(requests.filter((req) => req.method === "POST")).toHaveLength(0);
    expect(composer.getState().content).toContain("@missing");
    expect(composer.getState().status).toBe("");
    composer.dispose();
  }
});

test("pausing an upload and retrying cannot let the old completion clear its replacement owner", async () => {
  const requests = fixture();
  const composer = createFeedController({
    session,
    replyTo: { apId: parent, visibility: "public", communityApId: null },
    refreshHome: async () => {},
  });
  const first = composer.addFiles([
    new File([new Uint8Array([1, 2, 3])], "reply.png", { type: "image/png" }),
  ]);
  await until(() => requests.length === 1);
  const id = composer.getState().attachments[0]!.id;
  composer.pause();
  expect(requests[0]!.init?.signal?.aborted).toBe(true);
  expect(composer.getState().attachments[0]?.phase).toBe("error");
  const next = composer.retryAttachment(id);
  await until(() => requests.length === 2);
  const receipt = () =>
    Response.json({
      r2_key: `uploads/${"a".repeat(32)}.png`,
      url: `/media/${"a".repeat(32)}.png`,
      content_type: "image/png",
      expires_at: "2099-01-01T00:00:00Z",
    });
  requests[0]!.resolve(receipt());
  await first;
  composer.dispose();
  expect(requests[1]!.init?.signal?.aborted).toBe(true);
  requests[1]!.resolve(receipt());
  await next;
  expect(composer.getState().attachments).toEqual([]);
});

test("the existing 15s mutation budget includes the persisted reply GET body", async () => {
  let calls = 0,
    aborted = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(request) {
      calls++;
      if (request.method === "POST") return accepted();
      request.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"post":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  const start = performance.now();
  const result = await createPost(
    { ...session, hostUrl: server.url.origin },
    "reply",
    "public",
    [],
    undefined,
    { apId: parent, communityApId: null },
  ).then(
    () => "unexpected-success",
    () => "unconfirmed",
  );
  expect(result).toBe("unconfirmed");
  expect(performance.now() - start).toBeGreaterThanOrEqual(14_000);
  await until(() => aborted);
  expect(calls).toBe(2);
}, 20_000);

test("self-only direct mentions retain the draft and send no POST", async () => {
  for (const handle of ["@owner", "@owner@a.social.example"]) {
    const calls: { path: string; method: string }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ path, method });
      if (path === "/api/auth/me" || path.startsWith("/api/actors/"))
        return Response.json({ actor });
      if (method === "POST") return accepted();
      return saved({ visibility: "direct" });
    }) as typeof fetch;
    const composer = createFeedController({
      session,
      replyTo: { apId: parent, visibility: "direct", communityApId: null },
      refreshHome: async () => {},
    });
    composer.setDraft(`${handle} reply only to myself`);
    await composer.submit();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(composer.getState().content).toContain(handle);
    expect(composer.getState().status).toBe("");
    expect(composer.getState().error).toContain("宛先");
    composer.dispose();
  }
});

test("a direct reply can mention self with another explicit recipient and canonicalizes only the lookup host", async () => {
  const calls: { path: string; method: string; body?: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body as string | undefined });
    if (path === "/api/auth/me") return Response.json({ actor });
    if (path.startsWith("/api/actors/")) {
      const own = decodeURIComponent(path).endsWith("/owner");
      return Response.json({
        actor: own
          ? actor
          : {
              ...actor,
              ap_id: "https://a.social.example/ap/users/other",
              preferred_username: "other",
            },
      });
    }
    if (method === "POST") return accepted();
    return saved({ visibility: "direct" });
  }) as typeof fetch;
  const composer = createFeedController({
    session,
    replyTo: { apId: parent, visibility: "direct", communityApId: null },
    refreshHome: async () => {},
  });
  const content = "@owner @other@A.SOCIAL.EXAMPLE explicit recipient";
  composer.setDraft(content);
  await composer.submit();
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(calls.map((call) => call.path)).toContain(
    "/api/actors/other%40a.social.example",
  );
  expect(
    JSON.parse(calls.find((call) => call.method === "POST")!.body!).content,
  ).toBe(content);
  expect(composer.getState().content).toBe("");
  expect(composer.getState().status).toBe("返信を投稿しました。");
  composer.dispose();
});

for (const response of [
  () => new Response("unauthorized", { status: 401 }),
  () => Response.json({ actor: { ...actor, ap_id: undefined } }),
]) {
  test("an unavailable selected identity cannot authorize any direct reply POST", async () => {
    const requests = fixture();
    const composer = createFeedController({
      session,
      replyTo: { apId: parent, visibility: "direct", communityApId: null },
      refreshHome: async () => {},
    });
    composer.setDraft("@other explicit reply");
    const pending = composer.submit();
    requests[0]!.resolve(response());
    await pending;
    expect(new URL(requests[0]!.url).pathname).toBe("/api/auth/me");
    expect(requests).toHaveLength(1);
    expect(composer.getState().content).toBe("@other explicit reply");
    expect(composer.getState().status).toBe("");
    composer.dispose();
  });
}
