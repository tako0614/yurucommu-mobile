import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { createNotificationController } from "../src/notification-controller.ts";
import { deleteMobileOwnPost, MobilePostDeleteError } from "../src/post-delete-api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const base = "https://post-delete.fixture.test", owner = base + "/ap/users/me", id = base + "/ap/posts/own";
const session: MobileSession = { hostUrl: base, product: "yurucommu", accessToken: "local-delete-fixture", tokenType: "Bearer", createdAt: "2026-11-04T00:00:00Z" };
function wirePost(author = owner) {
  return { ap_id: id, type: "Note", author: { ap_id: author, username: "me", preferred_username: "me", name: null, icon_url: null }, content: "Own post", summary: null, attachments: [], in_reply_to: null, visibility: "public", community_ap_id: null, like_count: 0, reply_count: 0, announce_count: 0, published: "2026-11-04T00:00:00Z", edited_at: null, liked: false, bookmarked: false, reposted: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function fixture(options: { author?: string; me?: string; confirm?: () => boolean | Promise<boolean>; refresh?: () => Promise<void> } = {}) {
  const calls: Array<{ path: string; method: string; authorization: string | null }> = [];
  let exists = true, deleteResponse: Response | Promise<Response> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method, authorization: new Headers(init?.headers).get("authorization") });
    if (url.pathname === "/api/auth/me") return Response.json({ actor: { ap_id: options.me ?? owner } });
    if (url.pathname === "/api/posts/" + encodeURIComponent(id)) {
      if (method === "DELETE") {
        if (deleteResponse) return deleteResponse;
        exists = false;return Response.json({ success: true });
      }
      return exists ? Response.json({ post: wirePost(options.author) }) : Response.json({ error: "Post not found" }, { status: 404 });
    }
    throw Error("Unexpected fixture request: " + method + " " + url.pathname);
  }) as typeof fetch;
  let refreshed = 0;
  const c = createNotificationController({ session, getActorId: () => owner, confirmDeletePost: options.confirm ?? (() => true), onPostDeleted: async () => { refreshed++;await options.refresh?.(); } });
  return { c, calls, deletes: () => calls.filter(call => call.method === "DELETE"), refreshed: () => refreshed, failDelete: (response: Response | Promise<Response>) => { deleteResponse = response; } };
}

test("own post deletion uses current identity and confirmed ACK before leaving the detail", async () => {
  const f = fixture();
  try {
    await f.c.openPost(id);
    expect(f.c.ownsCurrentPost()).toBe(true);
    expect(f.c.canDeletePost()).toBe(true);
    await f.c.deleteOwnPost();
    expect(f.deletes()).toHaveLength(1);
    expect(f.calls.every(call => call.authorization === "Bearer local-delete-fixture")).toBe(true);
    expect(f.c.getState().page).toBe("home");
    expect(f.c.getState().postDeleteStatus).toContain("削除しました");
    expect(f.refreshed()).toBe(1);
  } finally { f.c.dispose(); }
});

test("cancelled confirmation and another author's post cause no DELETE", async () => {
  const cancelled = fixture({ confirm: () => false });
  try { await cancelled.c.openPost(id);await cancelled.c.deleteOwnPost();expect(cancelled.deletes()).toHaveLength(0);expect(cancelled.c.getState().post?.ap_id).toBe(id); }
  finally { cancelled.c.dispose(); }
  const other = fixture({ author: base + "/ap/users/other" });
  try { await other.c.openPost(id);expect(other.c.ownsCurrentPost()).toBe(false);await other.c.deleteOwnPost();expect(other.deletes()).toHaveLength(0); }
  finally { other.c.dispose(); }
});

test("the current auth response must still name the displayed post's author", async () => {
  const f = fixture({ me: base + "/ap/users/other" });
  try {
    await f.c.openPost(id);await f.c.deleteOwnPost();
    expect(f.deletes()).toHaveLength(0);
    expect(f.c.getState().postDeleteError).toContain("削除は送信していません");
    expect(f.c.getState().postDeleteError).not.toContain("結果が不明");
    expect(f.c.getState().post?.ap_id).toBe(id);
  } finally { f.c.dispose(); }
});

test("a reply draft is kept and blocks deletion and confirmation", async () => {
  let confirmations = 0;
  const f = fixture({ confirm: () => { confirmations++;return true; } });
  try {
    await f.c.openPost(id);f.c.getReplyComposer()!.setDraft("Keep my reply");
    expect(f.c.canDeletePost()).toBe(false);await f.c.deleteOwnPost();
    expect(confirmations).toBe(0);expect(f.deletes()).toHaveLength(0);
    expect(f.c.getReplyComposer()!.getState().content).toBe("Keep my reply");
  } finally { f.c.dispose(); }
});

test("unknown deletion keeps the detail and blocks repeat/like-related mutations until a real reload", async () => {
  const f = fixture();
  try {
    await f.c.openPost(id);f.failDelete(Response.json({ error: "lost ACK" }, { status: 500 }));
    await f.c.deleteOwnPost();
    expect(f.c.getState()).toMatchObject({ page: "post", postDeleteBusy: false, postDeleteNeedsReload: true });
    expect(f.c.getState().postDeleteError).toContain("結果が不明");
    expect(f.c.getState().post?.ap_id).toBe(id);
    await f.c.deleteOwnPost();await f.c.toggleBookmark();
    expect(f.deletes()).toHaveLength(1);
    expect(f.calls.filter(call => call.method !== "GET")).toHaveLength(1);
    f.c.getReplyComposer()!.setDraft("Cannot write while deletion is unknown");
    expect(f.c.getReplyComposer()!.getState().content).toBe("");
    await f.c.reload();expect(f.c.getState().postDeleteNeedsReload).toBe(false);
    expect(f.c.canDeletePost()).toBe(true);
  } finally { f.c.dispose(); }
});

test("a malformed successful DELETE ACK cannot remove the post", async () => {
  const f = fixture();
  try {
    await f.c.openPost(id);f.failDelete(Response.json({ success: false }));await f.c.deleteOwnPost();
    expect(f.c.getState().page).toBe("post");expect(f.c.getState().postDeleteNeedsReload).toBe(true);
    expect(f.c.getState().postDeleteStatus).toBe("");expect(f.refreshed()).toBe(0);
  } finally { f.c.dispose(); }
});

test("DELETE403 is a refusal, never a deletion success or an automatically retried effect", async () => {
  const f = fixture();
  try {
    await f.c.openPost(id);f.failDelete(Response.json({ error: "Forbidden" }, { status: 403 }));await f.c.deleteOwnPost();
    expect(f.c.getState().postDeleteError).toContain("403");expect(f.c.getState().postDeleteError).not.toContain("結果が不明");
    expect(f.c.getState().post?.ap_id).toBe(id);await f.c.deleteOwnPost();expect(f.deletes()).toHaveLength(1);
  } finally { f.c.dispose(); }
});

test("a successful receipt without persisted absence stays unconfirmed", async () => {
  const f = fixture();
  try {
    await f.c.openPost(id);f.failDelete(Response.json({ success: true }));await f.c.deleteOwnPost();
    expect(f.c.getState().page).toBe("post");expect(f.c.getState().postDeleteNeedsReload).toBe(true);
    expect(f.c.getState().postDeleteStatus).toBe("");expect(f.refreshed()).toBe(0);
  } finally { f.c.dispose(); }
});

test("changing view during confirmation or a pending DELETE suppresses old outcomes", async () => {
  const confirmation = deferred<boolean>(), before = fixture({ confirm: () => confirmation.promise });
  try {
    await before.c.openPost(id);const pending = before.c.deleteOwnPost();before.c.showHome();confirmation.resolve(true);await pending;
    expect(before.deletes()).toHaveLength(0);expect(before.c.getState().page).toBe("home");
  } finally { before.c.dispose(); }
  const response = deferred<Response>(), after = fixture();
  try {
    await after.c.openPost(id);after.failDelete(response.promise);const pending = after.c.deleteOwnPost();
    while (!after.deletes().length) await Bun.sleep(0);
    after.c.showHome();response.resolve(Response.json({ success: true }));await pending;
    expect(after.c.getState().page).toBe("home");expect(after.c.getState().postDeleteStatus).toBe("");expect(after.refreshed()).toBe(0);
  } finally { after.c.dispose(); }
});

test("double activation sends one DELETE and a failed home refresh does not replay it", async () => {
  const gate = deferred<boolean>(), f = fixture({ confirm: () => gate.promise, refresh: async () => { throw Error("offline"); } });
  try {
    await f.c.openPost(id);const first = f.c.deleteOwnPost();await f.c.deleteOwnPost();
    expect(f.deletes()).toHaveLength(0);gate.resolve(true);await first;
    expect(f.deletes()).toHaveLength(1);expect(f.c.getState().postDeleteStatus).toContain("削除済み");
    expect(f.c.getState().postDeleteNeedsReload).toBe(false);expect(f.c.getState().page).toBe("home");
  } finally { f.c.dispose(); }
});

for (const transition of ["session", "pause", "dispose"] as const) {
  test(`${transition} retires a pending deletion without adopting its late receipt`, async () => {
    const gate = deferred<Response>(), f = fixture();
    try {
      await f.c.openPost(id);f.failDelete(gate.promise);const pending = f.c.deleteOwnPost();
      while (!f.deletes().length) await Bun.sleep(0);
      if (transition === "session") f.c.updateSession({ ...session, accessToken: "new-local-incarnation" });
      else if (transition === "pause") f.c.pause();
      else f.c.dispose();
      gate.resolve(Response.json({ success: true }));await pending;
      expect(f.refreshed()).toBe(0);expect(f.c.getState().postDeleteStatus).toBe("");
      if (transition === "pause") expect(f.c.getState().postDeleteNeedsReload).toBe(true);
    } finally { f.c.dispose(); }
  });
}

test("the owner signal remains attached through the real DELETE HTTP body", async () => {
  const headers = deferred<void>(), aborted = deferred<void>();
  let actorId = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, fetch(request) {
    if (new URL(request.url).pathname === "/api/auth/me") return Response.json({ actor: { ap_id: actorId } });
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"success":')); } }), { headers: { "content-type": "application/json" } });
  } });
  actorId = server.url.origin + "/ap/users/me";
  const abort = new AbortController();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (init?.method === "DELETE") headers.resolve();
    return response;
  }) as typeof fetch;
  const pending = deleteMobileOwnPost({ ...session, hostUrl: server.url.origin }, server.url.origin + "/ap/posts/pending", actorId, abort.signal).catch(cause => cause);
  try {
    await headers.promise;abort.abort(Error("view retired"));
    const outcome = await Promise.race([pending, Bun.sleep(500).then(() => "still pending")]);
    expect(outcome).toBeInstanceOf(MobilePostDeleteError);
    expect(outcome.outcome).toBe("unknown");
    expect(await Promise.race([aborted.promise.then(() => true), Bun.sleep(500).then(() => false)])).toBe(true);
  } finally { abort.abort();server.stop(true);await pending; }
});

for (const transition of ["session", "view", "dispose"] as const) {
  test(`${transition} during the parent read after deletion cannot refresh a retired scope`, async () => {
    const parent = base + "/ap/posts/parent";
    const parentResponse = deferred<Response>();
    let parentReads = 0, deleted = false, refreshed = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/auth/me") return Response.json({ actor: { ap_id: owner } });
      if (path === "/api/posts/" + encodeURIComponent(parent)) {
        parentReads++;
        if (parentReads > 1) return parentResponse.promise;
        return Response.json({ post: { ...wirePost(), ap_id: parent } });
      }
      if (path === "/api/posts/" + encodeURIComponent(id)) {
        if (init?.method === "DELETE") { deleted = true;return Response.json({ success: true }); }
        return deleted ? Response.json({ error: "Post not found" }, { status: 404 }) : Response.json({ post: wirePost() });
      }
      throw Error("Unexpected request: " + path);
    }) as typeof fetch;
    const c = createNotificationController({ session, getActorId: () => owner, confirmDeletePost: () => true, onPostDeleted: async () => { refreshed++; } });
    try {
      await c.openPost(parent);await c.openReply(id);
      const pending = c.deleteOwnPost();
      const end = Date.now() + 500;
      while (parentReads < 2 && Date.now() < end) await Bun.sleep(1);
      expect(parentReads).toBe(2);
      if (transition === "session") c.updateSession({ ...session, accessToken: "next-local-account" });
      else if (transition === "view") c.showHome();
      else c.dispose();
      parentResponse.resolve(Response.json({ post: { ...wirePost(), ap_id: parent } }));
      await pending;
      expect(refreshed).toBe(0);
      expect(c.getState().postDeleteStatus).toBe("");
    } finally { c.dispose(); }
  });
}
