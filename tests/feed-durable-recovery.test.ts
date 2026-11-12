import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { loadHome } from "../src/api.ts";
import { createFeedController } from "../src/feed-controller.ts";
import { createFeedRecoveryStore } from "../src/feed-recovery.ts";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
test("the actual feed controller confirms original-intent storage before POST and keeps newer input", async () => {
  const entered = deferred(), release = deferred(), values = new Map<string, string>();
  let first = true, posts = 0, body = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/posts") return new Response("unexpected", { status: 404 });
    posts++; body = (await request.json() as { content: string }).content;
    return Response.json({ post: { ap_id: server.url.origin + "/ap/posts/one" } });
  } });
  const session = { product: "yurucommu" as const, hostUrl: server.url.origin, accessToken: "synthetic-local-only",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const store: MobileSecureStore = { kind: "secure", async get(key) { return values.get(key); },
    async set(key, raw) { if (first) { first = false; entered.resolve(); await release.promise; } values.set(key, raw); },
    async delete(key) { values.delete(key); } };
  const recovery = createFeedRecoveryStore({ store, scope: { product: "yurucommu", hostUrl: session.hostUrl, actorApId: "me" } });
  const controller = createFeedController({ session, refreshHome: async () => {}, recovery: { save: recovery.save } });
  let sending: Promise<void> | undefined;
  try {
    controller.setDraft("送信する元の投稿"); controller.setVisibility("followers"); sending = controller.submit();
    await Promise.race([entered.promise, sending]); expect(posts).toBe(0);
    controller.setDraft("保存待ちの間の新しい下書き"); release.resolve(); await sending;
    expect(body).toBe("送信する元の投稿"); expect(posts).toBe(1);
    expect(await recovery.load()).toMatchObject({ content: "保存待ちの間の新しい下書き", visibility: "followers" });
    expect((await recovery.load())?.intent).toBeUndefined();
  } finally { release.resolve(); await sending; controller.dispose(); server.stop(true); }
});


function fixture() {
  let posts = 0, uploads = 0, writeFailure = false, afterAckFailure = false, readFailure = false, unknown = false, readRefused = false;
  const values = new Map<string, string>();
  let heldRead: { entered: () => void; release: Promise<void> } | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      if (readRefused) return new Response("synthetic read failure", { status: 503 });
      if (path === "/api/auth/me") return Response.json({ actor: { ap_id: "me", preferred_username: "me", name: null, icon_url: null } });
      if (path === "/api/timeline") return Response.json({ posts: [], has_more: false, next_cursor: null });
      if (path === "/api/notifications/unread/count") return Response.json({ count: 0 });
    }
    if (request.method === "POST" && path === "/api/media/upload") {
      uploads++; return Response.json({ r2_key: "uploads/aa.png", url: "/media/aa.png", content_type: "image/png", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (request.method === "POST" && path === "/api/posts") {
      posts++; return unknown ? new Response("synthetic unknown", { status: 503 }) : Response.json({ post: { ap_id: server.url.origin + "/ap/posts/" + posts } });
    }
    return new Response("unexpected fixture request", { status: 404 });
  } });
  const session = { product: "yurucommu" as const, hostUrl: server.url.origin, accessToken: "synthetic-local-only",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const store: MobileSecureStore = { kind: "secure", async get(key) { if (readFailure) throw new Error("synthetic read failure"); const value = values.get(key); if (heldRead) { const held = heldRead; heldRead = undefined; held.entered(); await held.release; } return value; },
    async set(key, raw) { if (writeFailure || (afterAckFailure && posts > 0)) throw new Error("synthetic write failure"); values.set(key, raw); },
    async delete(key) { if (writeFailure || (afterAckFailure && posts > 0)) throw new Error("synthetic cleanup failure"); values.delete(key); } };
  const recovery = createFeedRecoveryStore({ store, scope: { product: "yurucommu", hostUrl: session.hostUrl, actorApId: "me" } });
  const controllers: ReturnType<typeof createFeedController>[] = [];
  return { recovery, session,
    create() { const c = createFeedController({ session, recovery, readRecoveryOutcome: async () => { await loadHome(session); }, refreshHome: async () => { await loadHome(session); } }); controllers.push(c); return c; },
    holdRead: (entered: () => void, release: Promise<void>) => { heldRead = { entered, release }; },
    counts: () => ({ posts, uploads }), failWrites: (value: boolean) => { writeFailure = value; },
    failAfterAck: (value: boolean) => { afterAckFailure = value; }, failReads: (value: boolean) => { readFailure = value; },
    unknown: (value: boolean) => { unknown = value; }, refuseRead: (value: boolean) => { readRefused = value; },
    close() { controllers.forEach(c => c.dispose()); server.stop(true); },
  };
}

test("unknown original posts and newer drafts restore separately, then need successful read and explicit confirmation", async () => {
  const f = fixture();
  try {
    const first = f.create(); await first.restoreRecovery(); first.setDraft("結果不明の元の投稿"); first.setVisibility("followers");
    f.unknown(true); await first.submit(); first.setDraft("後から書いた次の投稿"); await first.flushRecovery(); first.dispose();
    const next = f.create(); await next.restoreRecovery();
    expect(next.getState()).toMatchObject({ content: "後から書いた次の投稿", visibility: "followers", canSubmit: false,
      recovery: { intent: { content: "結果不明の元の投稿", visibility: "followers", phase: "uncertain" } } });
    await next.submit(); expect(f.counts().posts).toBe(1);
    f.refuseRead(true); await next.reviewRecoveryOutcome(); await next.confirmRecoveryReview();
    expect(next.getState().canSubmit).toBe(false); expect(f.counts().posts).toBe(1);
    f.refuseRead(false); await next.reviewRecoveryOutcome(); expect(next.getState().recovery?.canConfirmReview).toBe(true);
    await next.confirmRecoveryReview();
    expect(next.getState()).toMatchObject({ content: "後から書いた次の投稿", canSubmit: true });
    expect((await f.recovery.load())?.intent).toBeUndefined(); expect(f.counts().posts).toBe(1);
  } finally { f.close(); }
});

test("a failed pre-POST write blocks the actual SDK mutation until explicit save retry", async () => {
  const f = fixture();
  try {
    const c = f.create(); await c.restoreRecovery(); c.setDraft("保存するまでは送らない"); f.failWrites(true);
    await c.submit(); expect(f.counts().posts).toBe(0); expect(c.getState().recovery?.error).not.toBe("");
    expect(c.getState().content).toBe("保存するまでは送らない");
    f.failWrites(false); await c.flushRecovery(); expect(c.getState().canSubmit).toBe(true);
    await c.submit(); expect(f.counts().posts).toBe(1);
  } finally { f.close(); }
});

test("an unreadable prior draft is never replaced by startup or local input", async () => {
  const f = fixture();
  try {
    const c = f.create(); await c.restoreRecovery(); c.setDraft("保護する元の投稿"); await c.flushRecovery(); c.dispose();
    f.failReads(true); const next = f.create(); await next.restoreRecovery(); next.setDraft("上書きしない"); await next.submit();
    expect(next.getState().recovery?.ready).toBe(false); expect(f.counts().posts).toBe(0);
    f.failReads(false); await next.flushRecovery(); expect(next.getState().content).toBe("保護する元の投稿");
    expect((await f.recovery.load())?.content).toBe("保護する元の投稿");
  } finally { f.close(); }
});

test("a confirmed post stays accepted when its final recovery checkpoint fails", async () => {
  const f = fixture();
  try {
    const c = f.create(); await c.restoreRecovery(); c.setDraft("ACKを確認した元投稿"); f.failAfterAck(true); await c.submit();
    expect(c.getState().status).toBe("投稿を送信しました。"); expect(c.getState().error).toBe("");
    expect(c.getState().recovery?.error).not.toBe(""); c.setDraft("次の入力は保持"); await c.submit(); expect(f.counts().posts).toBe(1);
    f.failAfterAck(false); await c.flushRecovery();
    expect(await f.recovery.load()).toMatchObject({ content: "次の入力は保持" });
    expect((await f.recovery.load())?.intent).toBeUndefined(); expect(f.counts().posts).toBe(1);
  } finally { f.close(); }
});

test("a restored upload receipt remains usable without manufacturing a File or uploading again", async () => {
  const f = fixture();
  try {
    const c = f.create(); await c.restoreRecovery(); c.setDraft("添付を復元する投稿");
    await c.addFiles([new File([new Uint8Array([137,80,78,71])], "元の画像.png", { type: "image/png" })]);
    await c.flushRecovery(); c.dispose(); const next = f.create(); await next.restoreRecovery();
    expect(next.getState().attachments).toMatchObject([{ name: "元の画像.png", phase: "ready", previewUrl: "" }]);
    expect(f.counts().uploads).toBe(1); await next.submit(); expect(f.counts()).toEqual({ uploads: 1, posts: 1 });
  } finally { f.close(); }
});


test("a generic refresh callback cannot stand in for a successful canonical outcome read", async () => {
  const f = fixture(); let next: ReturnType<typeof createFeedController> | undefined;
  try {
    const first = f.create(); await first.restoreRecovery(); first.setDraft("確認が必要な元投稿"); f.unknown(true); await first.submit(); first.dispose();
    next = createFeedController({ session: f.session, recovery: f.recovery, refreshHome: async () => {} });
    await next.restoreRecovery(); await next.reviewRecoveryOutcome(); await next.confirmRecoveryReview();
    expect(next.getState().recovery?.intent?.content).toBe("確認が必要な元投稿");
    expect(next.getState().canSubmit).toBe(false); expect(f.counts().posts).toBe(1);
  } finally { next?.dispose(); f.close(); }
});

test("late old-scope reads cannot restore private input into a changed credential incarnation", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const first = f.create(); await first.restoreRecovery(); first.setDraft("古い資格の下書き"); await first.flushRecovery(); first.dispose();
    const next = f.create(); f.holdRead(entered.resolve, release.promise); const reading = next.restoreRecovery(); await entered.promise;
    next.updateSession({ ...f.session, accessToken: "synthetic-replacement" }); release.resolve(); await reading;
    expect(next.getState().content).toBe(""); expect(next.getState().canSubmit).toBe(false);
    expect((await f.recovery.load())?.content).toBe("古い資格の下書き"); expect(f.counts().posts).toBe(0);
  } finally { release.resolve(); f.close(); }
});


test("explicit clear persists an empty ordinary draft without broadening its audience or posting", async () => {
  const f = fixture();
  try {
    const c = f.create(); await c.restoreRecovery(); c.setDraft("消す現在の下書き"); c.setVisibility("followers"); await c.flushRecovery();
    c.clearDraft(); await c.flushRecovery(); c.dispose(); const next = f.create(); await next.restoreRecovery();
    expect(next.getState()).toMatchObject({ content: "", visibility: "followers", attachments: [], canSubmit: false });
    expect(f.counts().posts).toBe(0);
  } finally { f.close(); }
});
