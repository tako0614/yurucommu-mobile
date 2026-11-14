import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createFeedRecoveryAccounts, createFeedRecoveryStore } from "../src/feed-recovery.ts";
import { createNotificationController } from "../src/notification-controller.ts";

function fixture() {
  const values = new Map<string, string>();
  let posts = 0, unknown = false, readFailure = false, writeFailure = false, failAfterAck = false, ownParent = false;
  let heldRead: { entered: () => void; release: Promise<void> } | undefined;
  const sent: Record<string, unknown>[] = [];
  const parent = "https://peer.example/ap/posts/one", second = "https://peer.example/ap/posts/two";
  let visibility = "public", community: string | null = "https://peer.example/ap/communities/club";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/api/posts/" + encodeURIComponent(parent) || path === "/api/posts/" + encodeURIComponent(second))) {
      return Response.json({ post: { ap_id: decodeURIComponent(path.slice("/api/posts/".length)), type: "Note", content: "Canonical parent",
        visibility, community_ap_id: community, author: { ap_id: ownParent ? scope.actorApId : "https://peer.example/ap/users/peer", preferred_username: "peer", name: null, icon_url: null },
        published: "2026-11-11T00:00:00Z" } });
    }
    if (request.method === "GET" && path.endsWith("/replies")) return readFailure
      ? new Response("synthetic read failure", { status: 503 })
      : Response.json({ replies: [], has_more: false, next_cursor: null });
    if (request.method === "GET" && path === "/api/posts/" + encodeURIComponent(server.url.origin + "/ap/posts/saved")) {
      const body = sent[sent.length - 1]!;
      return Response.json({ post: { ap_id: server.url.origin + "/ap/posts/saved", in_reply_to: body.in_reply_to,
        visibility: body.visibility, community_ap_id: body.community_ap_id ?? null, author: { ap_id: scope.actorApId } } });
    }
    if (request.method === "POST" && path === "/api/posts") {
      posts++; sent.push(await request.json() as Record<string, unknown>);
      return unknown ? new Response("synthetic unknown ACK", { status: 503 })
        : Response.json({ post: { ap_id: server.url.origin + "/ap/posts/saved", author: { ap_id: scope.actorApId } } });
    }
    return new Response("unexpected fixture request", { status: 404 });
  } });
  const session = { product: "yurucommu" as const, hostUrl: server.url.origin, accessToken: "synthetic-local-only",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const store: MobileSecureStore = { kind: "secure", async get(key) {
    const raw = values.get(key); if (heldRead) { const held = heldRead; heldRead = undefined; held.entered(); await held.release; } return raw;
  }, async set(key, raw) { if (writeFailure || (failAfterAck && posts > 0)) throw new Error("synthetic write failure"); values.set(key, raw); }, async delete(key) { if (writeFailure || (failAfterAck && posts > 0)) throw new Error("synthetic cleanup failure"); values.delete(key); } };
  const scope = { product: "yurucommu" as const, hostUrl: session.hostUrl, actorApId: "https://me.example/ap/users/me" };
  const controllers: ReturnType<typeof createNotificationController>[] = [];
  return { values, session, store, scope, parent, second, sent,
    port: (replyParentApId: string) => createFeedRecoveryStore({ store, scope: { ...scope, replyParentApId } }),
    async open(id = parent) {
      const controller = createNotificationController({ session, getActorId: () => scope.actorApId,
        replyRecovery: target => createFeedRecoveryStore({ store, scope: { ...scope, replyParentApId: target.apId } }) });
      controllers.push(controller); await controller.openPost(id); const reply = controller.getReplyComposer();
      if (!reply) throw new Error("canonical reply composer unavailable: " + controller.getState().error);
      await reply.restoreRecovery(); return { controller, reply };
    },
    unknown: (value: boolean) => { unknown = value; }, refuseRead: (value: boolean) => { readFailure = value; },
    failWrites: (value: boolean) => { writeFailure = value; }, failAfterAck: (value: boolean) => { failAfterAck = value; },
    holdRead: (entered: () => void, release: Promise<void>) => { heldRead = { entered, release }; },
    parentContext: (nextVisibility: string, nextCommunity: string | null) => { visibility = nextVisibility; community = nextCommunity; },
    ownParent: () => { ownParent = true; },
    counts: () => ({ posts }), close() { controllers.forEach(c => c.dispose()); server.stop(true); },
  };
}

test("actual reply drafts survive recreation without becoming a feed draft or a different parent's draft", async () => {
  const f = fixture();
  try {
    const first = await f.open(); first.reply.setDraft("この親に残す返信"); await first.reply.flushRecovery(); first.controller.dispose();
    const next = await f.open(); expect(next.reply.getState()).toMatchObject({ content: "この親に残す返信", visibility: "public", canSubmit: true });
    const other = await f.open(f.second); expect(other.reply.getState().content).toBe("");
    const feed = createFeedRecoveryStore({ store: f.store, scope: f.scope }); expect(await feed.load()).toBeNull();
    expect(f.counts().posts).toBe(0);
  } finally { f.close(); }
});

test("the actual notification caller starts restoration after publishing the canonical parent", async () => {
  const f = fixture(); let controller: ReturnType<typeof createNotificationController> | undefined;
  let ready!: () => void; const restored = new Promise<void>(yes => { ready = yes; });
  try {
    controller = createNotificationController({ session: f.session, replyRecovery: target => f.port(target.apId),
      onChange: state => { if (state.replyDraft?.recovery?.ready) ready(); } });
    await controller.openPost(f.parent); await restored;
    controller.getReplyComposer()!.setDraft("利用者がその場で入力できる返信");
    expect(controller.getState().replyDraft?.content).toBe("利用者がその場で入力できる返信");
    expect(controller.getState().replyDraft?.canSubmit).toBe(true); expect(f.counts().posts).toBe(0);
  } finally { controller?.dispose(); f.close(); }
});

test("clearing the next draft cannot permit deleting a parent while the original reply remains unreviewed", async () => {
  const f = fixture();
  try {
    f.ownParent(); const current = await f.open(); expect(current.controller.canDeletePost()).toBe(true);
    current.reply.setDraft("元の返信の結果をまだ確認していない"); f.unknown(true); await current.reply.submit();
    current.reply.clearDraft(); await current.reply.flushRecovery();
    expect(current.reply.getState().content).toBe(""); expect(current.reply.getState().recovery?.intent).toBeDefined();
    expect(current.controller.canDeletePost()).toBe(false); expect(f.counts().posts).toBe(1);
  } finally { f.close(); }
});

test("reply storage failure blocks dispatch and an accepted reply survives a failed final checkpoint", async () => {
  const f = fixture();
  try {
    const first = await f.open(); first.reply.setDraft("保存してから送る返信"); f.failWrites(true); await first.reply.submit();
    expect(f.counts().posts).toBe(0); expect(first.reply.getState().content).toBe("保存してから送る返信");
    f.failWrites(false); await first.reply.flushRecovery(); f.failAfterAck(true); await first.reply.submit();
    expect(first.reply.getState().status).toBe("返信を投稿しました。"); expect(f.counts().posts).toBe(1);
    expect(first.reply.getState().recovery?.error).not.toBe(""); first.reply.setDraft("ACK後の次の返信"); await first.reply.submit();
    expect(f.counts().posts).toBe(1); f.failAfterAck(false); await first.reply.flushRecovery();
    expect(await f.port(f.parent).load()).toMatchObject({ content: "ACK後の次の返信", reply: { target: { apId: f.parent } } });
    expect((await f.port(f.parent).load())?.intent).toBeUndefined();
  } finally { f.close(); }
});

test("a parent reload during held restore ignores the retired read and can load current recovery", async () => {
  const f = fixture(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(yes => { enter = yes; }), released = new Promise<void>(yes => { release = yes; });
  let current: ReturnType<typeof createNotificationController> | undefined;
  try {
    const first = await f.open(); first.reply.setDraft("遅い復元でも保持する返信"); await first.reply.flushRecovery(); first.controller.dispose();
    f.holdRead(enter, released); current = createNotificationController({ session: f.session,
      replyRecovery: target => f.port(target.apId) });
    await current.openPost(f.parent); const reply = current.getReplyComposer()!;
    const old = reply.restoreRecovery(); await entered;
    f.parentContext("followers", null); await current.reload(); const latest = reply.restoreRecovery(); release(); await old; await latest;
    expect(reply.getState()).toMatchObject({ content: "遅い復元でも保持する返信", replyContextChanged: true, canSubmit: false,
      recovery: { ready: true, loading: false } });
    expect(current.getState().post?.replyContext).toEqual({ visibility: "followers", communityApId: null });
    expect(f.counts().posts).toBe(0);
  } finally { release(); current?.dispose(); f.close(); }
});

test("reply payloads cannot be adopted by another parent or the ordinary feed and rejection preserves bytes", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.reply.setDraft("元の親に結び付く本文"); await c.reply.flushRecovery();
    const data = (await f.port(f.parent).load())!; const bytes = JSON.stringify([...f.values]);
    await expect(f.port(f.second).save(data)).rejects.toMatchObject({ code: "invalid-data" });
    await expect(createFeedRecoveryStore({ store: f.store, scope: f.scope }).save(data)).rejects.toMatchObject({ code: "invalid-data" });
    await expect(f.port(f.parent).save({ ...data, reply: undefined })).rejects.toMatchObject({ code: "invalid-data" });
    expect(JSON.stringify([...f.values])).toBe(bytes);
  } finally { f.close(); }
});

test("actual row retirement cleans home and both reply views while preserving a fresh same-person row", async () => {
  const f = fixture(); let fail = true;
  try {
    const store = { ...f.store, async delete(key: string) { if (fail) throw new Error("synthetic cleanup failure"); await f.store.delete(key); } };
    const factory = createFeedRecoveryAccounts({ store });
    const row = { id: "saved_reply_A_001", product: "yurucommu" as const, hostUrl: f.session.hostUrl }, fresh = { ...row, id: "saved_reply_B_002" };
    const input = { accounts: { activeId: row.id, accounts: [{ ...row, lastUsedAt: "2026-11-11T00:00:00Z" }] }, session: f.session, actorApId: f.scope.actorApId };
    const home = { content: "ホームの下書き", visibility: "public" as const, attachments: [] };
    const data = { ...home, content: "投稿画面の返信", reply: { target: { apId: f.parent, communityApId: null, visibility: "public" as const }, audienceConfirmed: true } };
    await factory.select(input).save(home);
    await factory.select({ ...input, replyParentApId: f.parent }).save(data);
    await factory.select({ ...input, replyParentApId: f.parent, replyView: "profile" }).save({ ...data, content: "プロフィール内の返信" });
    expect(await factory.select({ ...input, replyParentApId: f.parent }).load()).toEqual(data);
    expect((await factory.select({ ...input, replyParentApId: f.parent, replyView: "profile" }).load())?.content).toBe("プロフィール内の返信");
    await factory.bind(fresh, { ...f.scope, replyParentApId: f.parent }).save({ ...data, content: "新しい行の返信" });
    expect(await factory.pendingCleanup({ accounts: [] })).toEqual([]);
    await expect(factory.retire(row)).rejects.toThrow();
    const restarted = createFeedRecoveryAccounts({ store: { ...store } });
    expect(await restarted.pendingCleanup({ accounts: [] })).toEqual([row]); fail = false; await restarted.retire(row);
    expect(await restarted.pendingCleanup({ accounts: [] })).toEqual([]);
    expect((await restarted.bind(fresh, { ...f.scope, replyParentApId: f.parent }).load())?.content).toBe("新しい行の返信");
    expect(() => factory.bind(row, f.scope)).toThrow();
  } finally { f.close(); }
});

test("unknown original reply context and newer input restore, then require real replies read and explicit decision", async () => {
  const f = fixture();
  try {
    const first = await f.open(); first.reply.setDraft("結果不明の元返信"); f.unknown(true); await first.reply.submit();
    first.reply.setDraft("その後の新しい返信"); await first.reply.flushRecovery(); first.controller.dispose();
    const next = await f.open();
    expect(next.reply.getState()).toMatchObject({ content: "その後の新しい返信", canSubmit: false,
      recovery: { intent: { content: "結果不明の元返信", phase: "uncertain", replyTo: { apId: f.parent, communityApId: "https://peer.example/ap/communities/club", visibility: "public" } } } });
    await next.reply.submit(); expect(f.counts().posts).toBe(1);
    f.refuseRead(true); await next.reply.reviewRecoveryOutcome(); await next.reply.confirmRecoveryReview();
    expect(next.reply.getState().canSubmit).toBe(false); expect(f.counts().posts).toBe(1);
    f.refuseRead(false); await next.reply.reviewRecoveryOutcome(); expect(next.controller.getState().repliesLoaded).toBe(true);
    await next.reply.confirmRecoveryReview(); expect(next.reply.getState().canSubmit).toBe(true);
    f.unknown(false); await next.reply.submit();
    expect(next.reply.getState().status).toBe("返信を投稿しました。"); expect(f.counts().posts).toBe(2);
    expect(f.sent[1]).toMatchObject({ content: "その後の新しい返信", in_reply_to: f.parent, community_ap_id: "https://peer.example/ap/communities/club", visibility: "public" });
  } finally { f.close(); }
});

test("a followers reply restores the actual audience choice and still requires direct recipients", async () => {
  const f = fixture();
  try {
    f.parentContext("followers", null); const first = await f.open(); first.reply.setDraft("公開先を選ぶ返信");
    await first.reply.flushRecovery(); first.controller.dispose(); const unchosen = await f.open();
    expect(unchosen.reply.getState()).toMatchObject({ content: "公開先を選ぶ返信", canSubmit: false, replyAudienceNeedsChoice: true });
    unchosen.reply.setVisibility("followers"); await unchosen.reply.flushRecovery(); unchosen.controller.dispose();
    const selected = await f.open(); expect(selected.reply.getState()).toMatchObject({ visibility: "followers", canSubmit: true, replyAudienceNeedsChoice: false });
    selected.reply.setVisibility("direct"); await selected.reply.flushRecovery(); selected.controller.dispose();
    const direct = await f.open(); expect(direct.reply.getState()).toMatchObject({ visibility: "direct", canSubmit: false, replyAudienceNeedsChoice: false });
    await direct.reply.submit(); expect(f.counts().posts).toBe(0);
  } finally { f.close(); }
});

test("changed canonical parent settings keep both drafts and old unknown context until explicit adoption", async () => {
  const f = fixture();
  try {
    const first = await f.open(); first.reply.setDraft("古い設定で送った返信"); f.unknown(true); await first.reply.submit();
    first.reply.setDraft("現在の下書き"); await first.reply.flushRecovery(); first.controller.dispose();
    f.parentContext("followers", null); const next = await f.open();
    expect(next.reply.getState()).toMatchObject({ content: "現在の下書き", replyContextChanged: true, canSubmit: false,
      recovery: { intent: { replyTo: { visibility: "public", communityApId: "https://peer.example/ap/communities/club" } } } });
    next.reply.setVisibility("followers"); await next.reply.flushRecovery();
    expect(next.reply.getState().visibility).toBe("public"); expect(next.reply.getState().recovery?.error).toBe("");
    await next.reply.confirmReplyContext();
    expect(next.reply.getState()).toMatchObject({ content: "現在の下書き", visibility: "followers", replyContextChanged: false, replyAudienceNeedsChoice: true, canSubmit: false });
    next.reply.setVisibility("followers"); await next.reply.reviewRecoveryOutcome(); await next.reply.confirmRecoveryReview();
    expect(next.reply.getState().canSubmit).toBe(true); expect(f.counts().posts).toBe(1);
    const saved = await f.port(f.parent).load(); expect(saved?.reply?.target).toEqual({ apId: f.parent, visibility: "followers", communityApId: null });
    expect(saved?.intent).toBeUndefined();
  } finally { f.close(); }
});


test("pending or failed reply restore blocks editing and deletion without blocking the post read", async () => {
  const f=fixture();let release!:()=>void;
  const held=new Promise<void>(done=>{release=done;});
  const owner=createNotificationController({session:f.session,getActorId:()=>f.scope.actorApId,
    replyRecovery:()=>({load:async()=>{await held;throw new Error("synthetic private read failure");},save:async()=>{throw new Error("unexpected write");}})});
  try {
    f.ownParent();await owner.openPost(f.parent);
    expect(owner.getState().post?.content).toBe("Canonical parent");
    expect(owner.canEditPost()).toBe(false);expect(owner.canDeletePost()).toBe(false);
    release();await owner.getReplyComposer()!.restoreRecovery();
    expect(owner.canEditPost()).toBe(false);expect(owner.canDeletePost()).toBe(false);
  } finally {release();owner.dispose();await f.close();}
});
