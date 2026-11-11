import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createPostEditController } from "../src/post-edit-controller.ts";
import { createPostEditRecoveryStore, type PostEditRecoveryScope } from "../src/post-edit-recovery.ts";
import { createFeedRecoveryAccounts } from "../src/feed-recovery.ts";

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() }; }

function fixture() {
  const values = new Map<string, string>(), bodies: unknown[] = [];
  let canonical = { content: "Canonical body", summary: "Canonical warning" };
  let failGet = false, failDelete = false, loseDeleteAck = false, unknown = false, failRead = false;
  let mutations = 0;
  let heldDelete: { enter: () => void; release: Promise<void> } | undefined;
  let heldGet: { enter: () => void; release: Promise<void> } | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname, host = server.url.origin, actor = host + "/users/me", id = host + "/posts/own";
    if (request.method === "GET" && path === "/api/auth/me") return Response.json({ actor: { ap_id: actor } });
    if (path !== "/api/posts/" + encodeURIComponent(id)) return new Response("unexpected local request", { status: 404 });
    if (request.method === "PATCH") {
      const patch = await request.json() as Partial<typeof canonical>; bodies.push(patch); canonical = { ...canonical, ...patch };
      return unknown ? new Response("synthetic unknown after write", { status: 503 }) : Response.json({ success: true, post: { ap_id: id, ...canonical } });
    }
    return failRead ? new Response("synthetic canonical read failure", { status: 503 }) : Response.json({ post: { ap_id: id, type: "Note", author: { ap_id: actor }, ...canonical, edited_at: null } });
  } });
  const session = { product: "yurucommu" as const, hostUrl: server.url.origin, tokenType: "Bearer", accessToken: "synthetic-local-only", createdAt: "2026-11-11T00:00:00Z" };
  const scope: PostEditRecoveryScope = { product: "yurucommu", hostUrl: session.hostUrl, actorApId: session.hostUrl + "/users/me", postApId: session.hostUrl + "/posts/own", view: "post" };
  const store: MobileSecureStore = { kind: "secure",
    async get(key) {
      if (failGet) throw new Error("synthetic storage read failure");
      const raw = values.get(key);
      if (heldGet) { const held = heldGet; heldGet = undefined; held.enter(); await held.release; }
      return raw;
    },
    async set(key, raw) { mutations++; values.set(key, raw); },
    async delete(key) {
      if (heldDelete) { const held = heldDelete; heldDelete = undefined; held.enter(); await held.release; }
      if (failDelete) throw new Error("synthetic storage delete failure");
      mutations++; values.delete(key); if (loseDeleteAck) throw new Error("synthetic lost delete acknowledgement");
    },
  };
  const controllers: ReturnType<typeof createPostEditController>[] = [];
  const port = () => createPostEditRecoveryStore({ store, scope });
  function corrupt() {
    const [key, raw] = [...values][0], data = JSON.parse(raw);
    values.set(key, JSON.stringify({ ...data, data: { ...data.data, draft: { ...data.data.draft, content: 123 } } }));
    return key;
  }
  return { values, bodies, session, scope, store, port, corrupt, mutations: () => mutations,
    async seed() { await port().save({ base: { ...canonical }, draft: { ...canonical, content: "保存した投稿編集" } }); return corrupt(); },
    async open() { const c = createPostEditController({ session, postId: scope.postApId, authorId: scope.actorApId, recovery: port, confirmDiscard: () => true }); controllers.push(c); await c.show(); return c; },
    failGet: (value: boolean) => { failGet = value; }, failDelete: (value: boolean) => { failDelete = value; },
    loseDeleteAck: (value: boolean) => { loseDeleteAck = value; }, unknown: (value: boolean) => { unknown = value; },
    failRead: (value: boolean) => { failRead = value; },
    holdDelete: (enter: () => void, release: Promise<void>) => { heldDelete = { enter, release }; },
    holdGet: (enter: () => void, release: Promise<void>) => { heldGet = { enter, release }; },
    async close() { controllers.forEach(c => c.dispose()); await Promise.all(controllers.map(c => c.flushRecovery())); server.stop(true); },
  };
}

test("the actual editor recovers identifiable corrupt saved contents only through explicit scoped confirmation", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), raw = f.values.get(key), before = f.mutations(), c = await f.open();
    await c.discardAndReload(); await c.reload();
    expect(c.getState().recovery?.ready).toBe(false); expect(c.getState().canSave).toBe(false);
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before); expect(f.bodies).toHaveLength(0);
    expect(c.getState().recovery?.canReviewInvalid).toBe(true);
    await c.reviewInvalidRecovery(); expect(c.getState().recovery?.invalidReview).toBe(true);
    expect(f.values.get(key)).toBe(raw); c.cancelInvalidRecoveryReview(); expect(f.values.get(key)).toBe(raw);
    await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(c.getState().recovery?.ready).toBe(true); expect(c.getState().base?.content).toBe("Canonical body");
    expect(f.values.has(key)).toBe(false); expect(f.bodies).toHaveLength(0);
    c.setField("content", "復帰して保存する本文"); await c.save();
    expect(f.bodies).toEqual([{ content: "復帰して保存する本文" }]);
  } finally { await f.close(); }
});

test("a warm editor invalidates old confirmation and preserves input typed during local discard", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const c = await f.open(); c.setField("content", "画面に残す入力"); await c.flushRecovery();
    const key = f.corrupt(), raw = f.values.get(key);
    expect(await c.flushRecovery()).toBe(false);
    await c.reviewInvalidRecovery(); expect(c.getState().recovery?.invalidReview).toBe(true);
    c.setField("content", "確認後の新しい入力"); await c.discardInvalidRecovery();
    expect(f.values.get(key)).toBe(raw); expect(c.getState().recovery?.invalidReview).toBe(false);
    await c.reviewInvalidRecovery(); f.holdDelete(entered.resolve, release.promise);
    const clearing = c.discardInvalidRecovery(); await entered.promise;
    c.setField("content", "破棄中も保持する最後の入力"); release.resolve(); await clearing;
    expect(c.getState().draft.content).toBe("破棄中も保持する最後の入力");
    expect(c.getState().canSave).toBe(true); expect(f.bodies).toHaveLength(0);
    await c.save(); expect(f.bodies).toEqual([{ content: "破棄中も保持する最後の入力" }]);
  } finally { release.resolve(); await f.close(); }
});

test("local corrupt-record removal never acknowledges or resends an unknown server edit", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("content", "応答不明の元の編集"); f.unknown(true); await c.save();
    expect(c.getState().uncertain).toBe(true); expect(f.bodies).toHaveLength(1);
    c.setField("content", "元の編集とは別の追加入力"); await c.flushRecovery(); f.corrupt(); await c.flushRecovery();
    await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(c.getState().draft.content).toBe("元の編集とは別の追加入力");
    expect(c.getState().uncertain).toBe(true); expect(c.getState().recovery?.attempted).toEqual({ content: "応答不明の元の編集" });
    expect(c.getState().canSave).toBe(false); expect(c.getState().recovery?.canConfirmReview).toBe(true);
    expect(f.bodies).toHaveLength(1);
    await c.confirmRecoveryReview(); expect(c.getState().uncertain).toBe(false); expect(f.bodies).toHaveLength(1);
    f.unknown(false); await c.save();
    expect(f.bodies).toEqual([{ content: "応答不明の元の編集" }, { content: "元の編集とは別の追加入力" }]);
  } finally { await f.close(); }
});

test("unreadable, foreign, unsupported, future or valid records cannot authorize local discard", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), invalid = JSON.parse(f.values.get(key)!);
    const values = ["not JSON", JSON.stringify({ ...invalid, scope: "another scope" }), JSON.stringify({ ...invalid, version: 2 }),
      JSON.stringify({ ...invalid, savedAt: Date.now() + 60_000 }), JSON.stringify({ ...invalid, extra: true }),
      JSON.stringify({ ...invalid, data: { base: { content: "baseline", summary: "" }, draft: { content: " ", summary: "" } } })];
    const before = f.mutations();
    for (const raw of values) {
      f.values.set(key, raw); await expect(f.port().reviewInvalid()).rejects.toThrow();
      expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before);
    }
    expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});

test("a changed valid saved edit survives stale discard and a cold editor explicitly reloads it", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), c = await f.open(); await c.reviewInvalidRecovery();
    const other = f.port(); await (await other.reviewInvalid()).discard();
    await other.save({ base: { content: "Canonical body", summary: "Canonical warning" }, draft: { content: "別のAppが保存した編集", summary: "Canonical warning" } });
    const next = f.values.get(key); await c.discardInvalidRecovery();
    expect(f.values.get(key)).toBe(next); expect(c.getState().canSave).toBe(false);
    await c.reload(); expect(c.getState().draft.content).toBe("別のAppが保存した編集");
    expect(c.getState().recovery?.ready).toBe(true); expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});

test("pausing an invalid warm editor never implicitly overwrites a later valid saved edit", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("content", "この画面の入力"); await c.flushRecovery(); const key = f.corrupt(); await c.flushRecovery();
    await c.reviewInvalidRecovery();
    const other = f.port(); await (await other.reviewInvalid()).discard();
    await other.save({ base: { content: "Canonical body", summary: "Canonical warning" }, draft: { content: "後から保存された編集", summary: "Canonical warning" } });
    const next = f.values.get(key); await c.discardInvalidRecovery(); await c.reload();
    expect(c.getState().draft.content).toBe("この画面の入力"); expect(c.getState().canSave).toBe(false);
    c.hide(); await other.load(); expect(f.values.get(key)).toBe(next);
    c.dispose(); await other.load(); expect(f.values.get(key)).toBe(next); expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});

for (const warm of [false, true]) test(`${warm ? "warm" : "cold"} delete failure preserves work; lost delete acknowledgement requires explicit read`, async () => {
  const f = fixture();
  try {
    let c: Awaited<ReturnType<typeof f.open>>, key: string;
    if (warm) { c = await f.open(); c.setField("content", "保持する未送信入力"); await c.flushRecovery(); key = f.corrupt(); await c.flushRecovery(); }
    else { key = await f.seed(); c = await f.open(); }
    const raw = f.values.get(key), before = f.mutations();
    f.failGet(true); await c.reviewInvalidRecovery(); expect(c.getState().recovery?.invalidReview).toBe(false);
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before);
    f.failGet(false); await c.reviewInvalidRecovery(); f.failDelete(true); await c.discardInvalidRecovery();
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before); expect(c.getState().canSave).toBe(false);
    f.failDelete(false); f.loseDeleteAck(true); await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(f.values.has(key)).toBe(false); expect(c.getState().canSave).toBe(false);
    expect(c.getState().recovery?.error).toBeTruthy(); expect(f.bodies).toHaveLength(0);
    f.loseDeleteAck(false); await c.reload(); expect(c.getState().recovery?.error).toBe(""); expect(c.getState().recovery?.ready).toBe(true);
    expect(c.getState().draft.content).toBe(warm ? "保持する未送信入力" : "Canonical body");
    if (!warm) c.setField("content", "読取確認後の入力");
    await c.save(); expect(f.bodies).toEqual([{ content: warm ? "保持する未送信入力" : "読取確認後の入力" }]);
  } finally { await f.close(); }
});

for (const retire of ["cancel", "hide", "dispose"] as const) test(`late corrupt-record review cannot revive confirmation after ${retire}`, async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const key = await f.seed(), raw = f.values.get(key), c = await f.open(), before = f.mutations();
    f.holdGet(entered.resolve, release.promise); const reviewing = c.reviewInvalidRecovery(); await entered.promise;
    if (retire === "cancel") c.cancelInvalidRecoveryReview(); else if (retire === "hide") c.hide(); else c.dispose();
    release.resolve(); await reviewing; await c.discardInvalidRecovery();
    expect(c.getState().recovery?.invalidReview).toBe(false); expect(f.values.get(key)).toBe(raw);
    expect(f.mutations()).toBe(before); expect(f.bodies).toHaveLength(0);
  } finally { release.resolve(); await f.close(); }
});

test("local discard cannot bypass a failed canonical read", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), c = await f.open(); await c.reviewInvalidRecovery(); f.failRead(true); await c.discardInvalidRecovery();
    expect(f.values.has(key)).toBe(false); expect(c.getState().canSave).toBe(false); expect(c.getState().needsReload).toBe(true);
    await c.save(); expect(f.bodies).toHaveLength(0);
    f.failRead(false); await c.reload(); expect(c.getState().recovery?.ready).toBe(true); expect(c.getState().base?.content).toBe("Canonical body");
  } finally { await f.close(); }
});

test("actual saved-row namespaces isolate post/view/API/actor and retirement invalidates old confirmation", async () => {
  const f = fixture();
  try {
    const row = { id: "invalid_post_edit_row_A_001", hostUrl: f.session.hostUrl, product: "yurucommu" as const, accountId: "subject", lastUsedAt: f.session.createdAt };
    const fresh = { ...row, id: "invalid_post_edit_row_B_002" }, accounts = createFeedRecoveryAccounts({ store: f.store });
    const select = (selected = row, scope = f.scope) => createPostEditRecoveryStore({ store: accounts.accountStorage({ accounts: { activeId: selected.id, accounts: [selected] }, session: { ...f.session, accountId: "subject" } }), scope });
    const data = { base: { content: "baseline", summary: "" }, draft: { content: "saved", summary: "" } };
    const old = select(); await old.save(data);
    const envelope = [...f.values].find(([, raw]) => { try { return Object.hasOwn(JSON.parse(raw), "entries"); } catch { return false; } });
    expect(envelope).toBeDefined();
    const [envelopeKey, envelopeRaw] = envelope!, value = JSON.parse(envelopeRaw), editKey = value.entries[0][0];
    const raw = JSON.parse(value.entries[0][1]); raw.data.draft.content = 123; value.entries[0][1] = JSON.stringify(raw); f.values.set(envelopeKey, JSON.stringify(value));
    const siblings = [select(row, { ...f.scope, view: "profile" }), select(row, { ...f.scope, postApId: f.session.hostUrl + "/posts/other" }),
      select(row, { ...f.scope, actorApId: f.session.hostUrl + "/users/other" }), select(row, { ...f.scope, apiBaseUrl: f.session.hostUrl + "/alternate/api" }), select(fresh)];
    for (const sibling of siblings) await sibling.save(data);
    const review = await old.reviewInvalid(); await review.discard(); expect(await old.load()).toBe(null);
    for (const sibling of siblings) expect((await sibling.load())?.draft.content).toBe("saved");
    await old.save(data);
    const current = JSON.parse(f.values.get(envelopeKey)!), tuple = current.entries.find(([key]: [string, string]) => key === editKey), entry = JSON.parse(tuple[1]); entry.data.draft.content = 123;
    tuple[1] = JSON.stringify(entry); f.values.set(envelopeKey, JSON.stringify(current));
    const stale = await old.reviewInvalid(); await accounts.retire(row); const afterRetire = [...f.values];
    await expect(stale.discard()).rejects.toThrow(); expect([...f.values]).toEqual(afterRetire);
    expect((await siblings.at(-1)!.load())?.draft.content).toBe("saved"); expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});
