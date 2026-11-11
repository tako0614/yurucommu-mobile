import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createPostEditController } from "../src/post-edit-controller.ts";
import { createPostEditRecoveryStore, type PostEditRecoveryScope } from "../src/post-edit-recovery.ts";
import { createFeedRecoveryAccounts } from "../src/feed-recovery.ts";

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() }; }
function fixture() {
  const values = new Map<string, string>(), bodies: unknown[] = [];
  let canonical = { content: "Canonical body", summary: "Canonical warning" }, unknown = false, writeFailure = false, afterAckFailure = false, readFailure = false;
  let heldWrite: { entered: () => void; release: Promise<void> } | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname, actorApId = server.url.origin + "/users/me", id = server.url.origin + "/posts/own";
    if (request.method === "GET" && path === "/api/auth/me") return Response.json({ actor: { ap_id: actorApId } });
    if (path !== "/api/posts/" + encodeURIComponent(id)) return new Response("unexpected fixture request", { status: 404 });
    if (request.method === "PATCH") {
      const patch = await request.json() as Partial<typeof canonical>; bodies.push(patch); canonical = { ...canonical, ...patch };
      return unknown ? new Response("synthetic unknown after fixture write", { status: 503 }) : Response.json({ success: true, post: { ap_id: id, ...canonical } });
    }
    return readFailure ? new Response("synthetic read failure", { status: 503 }) : Response.json({ post: { ap_id: id, type: "Note", author: { ap_id: actorApId }, ...canonical, edited_at: null } });
  } });
  const session = { hostUrl: server.url.origin, product: "yurucommu" as const, tokenType: "Bearer", accessToken: "synthetic-local-only", createdAt: "2026-11-11T00:00:00Z" };
  const scope: PostEditRecoveryScope = { product: "yurucommu", hostUrl: session.hostUrl, actorApId: session.hostUrl + "/users/me", postApId: session.hostUrl + "/posts/own", view: "post" };
  const store: MobileSecureStore = { kind: "secure", async get(key) { return values.get(key); }, async set(key, raw) {
    if (heldWrite) { const hold = heldWrite; heldWrite = undefined; hold.entered(); await hold.release; }
    if (writeFailure || afterAckFailure && bodies.length > 0) throw new Error("synthetic storage failure"); values.set(key, raw);
  }, async delete(key) { values.delete(key); } };
  const controllers: ReturnType<typeof createPostEditController>[] = [];
  const port = () => createPostEditRecoveryStore({ store, scope });
  return { session, scope, store, values, bodies, port,
    async open(recovery = port, confirmDiscard = () => true) {
      const c = createPostEditController({ session, postId: scope.postApId, authorId: scope.actorApId, recovery, confirmDiscard });
      controllers.push(c); await c.show(); return c;
    },
    unknown: (value: boolean) => { unknown = value; }, failWrites: (value: boolean) => { writeFailure = value; }, failAfterAck: (value: boolean) => { afterAckFailure = value; },
    refuseRead: (value: boolean) => { readFailure = value; }, remote: (value: Partial<typeof canonical>) => { canonical = { ...canonical, ...value }; },
    holdWrite: (entered: () => void, release: Promise<void>) => { heldWrite = { entered, release }; },
    async close() { controllers.forEach(c => c.dispose()); await Promise.all(controllers.map(c => c.flushRecovery())); server.stop(true); },
  };
}

test("actual editor recreation restores raw unsent fields without a PATCH", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("content", "終了後の投稿編集"); c.setField("summary", "未送信の警告"); expect(await c.flushRecovery()).toBe(true); c.dispose();
    const next = await f.open(); expect(next.getState()).toMatchObject({ draft: { content: "終了後の投稿編集", summary: "未送信の警告" }, canSave: true }); expect(f.bodies).toHaveLength(0);
    await next.discardAndReload(); await next.flushRecovery(); next.dispose();
    expect((await f.open()).getState().draft.content).toBe("Canonical body");
  } finally { await f.close(); }
});

test("unknown original PATCH and newer editing survive, require read plus explicit review, and never replay", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("content", "元の変更"); f.unknown(true); await c.save();
    expect(c.getState().uncertain).toBe(true); c.setField("content", "その後の新しい入力"); await c.flushRecovery(); c.dispose();
    const next = await f.open(); expect(next.getState()).toMatchObject({ uncertain: true, canSave: false, draft: { content: "その後の新しい入力" }, recovery: { attempted: { content: "元の変更" }, canConfirmReview: false } });
    await next.save(); await next.confirmRecoveryReview(); expect(f.bodies).toHaveLength(1);
    await next.reload(); expect(next.getState().recovery?.canConfirmReview).toBe(true);
    f.refuseRead(true); await next.reload(); expect(next.getState().recovery?.canConfirmReview).toBe(false); await next.confirmRecoveryReview(); expect(next.getState().uncertain).toBe(true);
    f.refuseRead(false); await next.reload(); await next.confirmRecoveryReview(); expect(next.getState()).toMatchObject({ uncertain: false, canSave: true }); expect(f.bodies).toHaveLength(1);
    f.unknown(false); await next.save(); expect(f.bodies).toEqual([{ content: "元の変更" }, { content: "その後の新しい入力" }]);
  } finally { await f.close(); }
});

test("failed pre-send durable checkpoint refuses PATCH and supports explicit storage retry", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("content", "送信前の入力"); f.failWrites(true); await c.save();
    expect(f.bodies).toHaveLength(0); expect(c.getState()).toMatchObject({ uncertain: false, canSave: false }); expect(c.getState().recovery?.error).not.toBe("");
    f.failWrites(false); await c.flushRecovery(); await c.reload(); await c.save(); expect(f.bodies).toEqual([{ content: "送信前の入力" }]);
  } finally { await f.close(); }
});

test("a known canonical ACK stays known when the final recovery write fails", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("content", "ACK済み"); f.failAfterAck(true); await c.save();
    expect(c.getState()).toMatchObject({ uncertain: false, dirty: false }); expect(c.getState().status).toContain("保存しました"); expect(c.getState().recovery?.error).not.toBe("");
    await c.save(); expect(f.bodies).toHaveLength(1); f.failAfterAck(false); await c.flushRecovery(); c.dispose();
    const next = await f.open(); expect(next.getState()).toMatchObject({ uncertain: false, dirty: false }); expect(f.bodies).toHaveLength(1);
  } finally { await f.close(); }
});

test("read provenance and remote conflict are current API facts, not restored baseline authority", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("content", "こちらの入力"); await c.flushRecovery(); c.dispose(); f.remote({ content: "別writer" });
    const next = await f.open(); expect(next.getState()).toMatchObject({ canSave: false, draft: { content: "こちらの入力" }, recovery: { conflicts: ["content"], canConfirmReview: false } });
    await next.reload(); await next.confirmRecoveryReview(); f.remote({ content: "再び別writer" }); await next.save();
    expect(f.bodies).toHaveLength(0); expect(next.getState().needsReload).toBe(true); expect(next.getState().uncertain).toBe(false);
  } finally { await f.close(); }
});

test("actor, host, API, post and view mismatch refuse private reads", async () => {
  const f = fixture(); let loads = 0;
  try {
    for (const changed of [{ actorApId: f.scope.actorApId + "-other" }, { hostUrl: "https://other.fixture.test" }, { apiBaseUrl: f.scope.hostUrl + "/alternate" }, { postApId: f.scope.postApId + "-other" }, { view: "profile" as const }]) {
      const port = createPostEditRecoveryStore({ store: f.store, scope: { ...f.scope, ...changed } });
      const c = await f.open(() => ({ ...port, async load() { loads++; return port.load(); } }));
      expect(c.getState().recovery?.ready).toBe(false); expect(c.getState().canSave).toBe(false); c.dispose();
    }
    expect(loads).toBe(0); expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});

test("secure codec preserves invalid drafts but rejects extra authority or malformed attempted patches", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("content", " "); c.setField("summary", "x".repeat(600)); await c.flushRecovery(); c.dispose();
    const next = await f.open(); expect(next.getState().draft).toEqual({ content: " ", summary: "x".repeat(600) }); expect(next.getState().canSave).toBe(false);
    const port = f.port(), before = [...f.values];
    await expect(port.save({ base: { content: "a", summary: "" }, draft: { content: "a", summary: "" }, token: "refuse" } as never)).rejects.toThrow();
    await expect(port.save({ base: { content: "a", summary: "" }, draft: { content: "b", summary: "" }, attempted: { draft: { content: "b", summary: "" }, patch: { content: "different" } } })).rejects.toThrow();
    expect([...f.values]).toEqual(before); expect(Object.isFrozen(port.scope)).toBe(true);
    expect([...f.values.values()].join("")).not.toContain("synthetic-local-only");
  } finally { await f.close(); }
});

test("corrupt bytes are never silently replaced by a blank editor", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("content", "保存した入力"); await c.flushRecovery(); c.dispose();
    const key = [...f.values.keys()][0]; f.values.set(key, "invalid-json"); const next = await f.open();
    expect(next.getState().recovery?.ready).toBe(false); expect(next.getState().canSave).toBe(false); await next.flushRecovery(); expect(f.values.get(key)).toBe("invalid-json");
  } finally { await f.close(); }
});

test("newer input during a held pre-PATCH checkpoint survives while the original attempt is sent once", async () => {
  const f = fixture(), entered = deferred(), released = deferred(); let sending: Promise<void> | undefined;
  try {
    const c = await f.open(); c.setField("content", "元の送信入力"); f.holdWrite(entered.resolve, released.promise); sending = c.save(); await entered.promise;
    expect(f.bodies).toHaveLength(0); c.setField("content", "保存待ち中の新入力"); released.resolve(); await sending;
    expect(f.bodies).toEqual([{ content: "元の送信入力" }]); expect(c.getState()).toMatchObject({ draft: { content: "保存待ち中の新入力" }, dirty: true });
    c.dispose(); expect((await f.open()).getState().draft.content).toBe("保存待ち中の新入力");
  } finally { released.resolve(); await sending; await f.close(); }
});

test("dispose during a pending storage write drains the newest draft without new API work", async () => {
  const f = fixture(), entered = deferred(), released = deferred(); let writing: Promise<boolean> | undefined;
  try {
    const c = await f.open(); c.setField("content", "最初の入力"); f.holdWrite(entered.resolve, released.promise); writing = c.flushRecovery(); await entered.promise;
    c.setField("content", "終了前の最新入力"); c.dispose(); released.resolve(); await writing;
    expect((await f.open()).getState().draft.content).toBe("終了前の最新入力"); expect(f.bodies).toHaveLength(0);
  } finally { released.resolve(); await writing; await f.close(); }
});

test("the existing saved-row account store owns post-edit cleanup without erasing a replacement row", async () => {
  const f = fixture();
  try {
    const row = { id: "saved_post_edit_A_001", hostUrl: f.session.hostUrl, product: "yurucommu" as const, accountId: "subject", lastUsedAt: f.session.createdAt };
    const fresh = { ...row, id: "saved_post_edit_B_002" }, accounts = createFeedRecoveryAccounts({ store: f.store });
    const select = (selected: typeof row) => createPostEditRecoveryStore({ store: accounts.accountStorage({ accounts: { activeId: selected.id, accounts: [selected] }, session: { ...f.session, accountId: "subject" } }), scope: f.scope });
    const old = select(row), next = select(fresh), data = { base: { content: "a", summary: "" }, draft: { content: "private draft", summary: "" } };
    await old.save(data); await next.save(data); await accounts.retire(row);
    await expect(old.load()).rejects.toThrow(); expect((await next.load())?.draft.content).toBe("private draft"); expect(await accounts.pendingCleanup({ accounts: [] })).toEqual([]);
  } finally { await f.close(); }
});
