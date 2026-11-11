import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createProfileRecoveryStore, type ProfileRecoveryScope } from "../src/profile-recovery.ts";
import { createProfileEditController } from "../src/profile-edit-controller.ts";
import type { MobileProfileForm } from "../src/profile-edit-api.ts";
import { createFeedRecoveryAccounts } from "../src/feed-recovery.ts";

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() }; }
function fixture() {
  const values = new Map<string, string>(), patches: Partial<MobileProfileForm>[] = [];
  let canonical: MobileProfileForm = { name: "Canonical Name", summary: "Canonical summary", icon_url: "", header_url: "", is_private: false, fields: [] };
  let mutations = 0, reads = 0, uploads = 0, failGet = false, failDelete = false, lostDeleteAck = false, unknown = false, failRead = false;
  let heldGet: { enter: () => void; release: Promise<void> } | undefined, heldDelete: typeof heldGet;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname, id = server.url.origin + "/users/me", actor = { ap_id: id, preferred_username: "me", ...canonical };
    if (request.method === "GET" && (path === "/api/auth/me" || path === "/api/actors/" + encodeURIComponent(id)))
      return failRead ? new Response("synthetic read failure", { status: 503 }) : Response.json({ actor });
    if (request.method === "PUT" && path === "/api/actors/me") {
      const patch = await request.json() as Partial<MobileProfileForm>; patches.push(patch); canonical = { ...canonical, ...patch };
      return unknown ? new Response("synthetic unknown after write", { status: 503 }) : Response.json({ success: true });
    }
    if (request.method === "POST" && path === "/api/media/upload") {
      uploads++; await request.formData(); return Response.json({ r2_key: "uploads/aa.png", url: "/media/aa.png", content_type: "image/png", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return new Response("unexpected local request", { status: 404 });
  } });
  const session = { product: "yurucommu" as const, hostUrl: server.url.origin, tokenType: "Bearer", accessToken: "synthetic-local-only", createdAt: "2026-11-11T00:00:00Z" };
  const scope: ProfileRecoveryScope = { product: "yurucommu", hostUrl: session.hostUrl, actorApId: session.hostUrl + "/users/me" };
  const store: MobileSecureStore = { kind: "secure",
    async get(key) { reads++; if (failGet) throw Error("synthetic read failure"); const raw = values.get(key);
      if (heldGet) { const held = heldGet; heldGet = undefined; held.enter(); await held.release; } return raw; },
    async set(key, raw) { mutations++; values.set(key, raw); },
    async delete(key) { if (heldDelete) { const held = heldDelete; heldDelete = undefined; held.enter(); await held.release; }
      if (failDelete) throw Error("synthetic delete failure"); mutations++; values.delete(key); if (lostDeleteAck) throw Error("synthetic lost delete ACK"); },
  };
  const controllers: ReturnType<typeof createProfileEditController>[] = [], port = () => createProfileRecoveryStore({ store, scope });
  function corrupt() { const [key, raw] = [...values][0], data = JSON.parse(raw); data.data.draft.name = 123; values.set(key, JSON.stringify(data)); return key; }
  return { values, patches, session, scope, store, port, corrupt, mutations: () => mutations, reads: () => reads, uploads: () => uploads,
    async seed() { await port().save({ base: canonical, draft: { ...canonical, name: "保存したプロフィール" } }); return corrupt(); },
    async open(onChange?: () => void) { const c = createProfileEditController({ session, recovery: port, confirmDiscard: () => true, onChange }); controllers.push(c); await c.show(scope.actorApId); return c; },
    failGet: (value: boolean) => { failGet = value; }, failDelete: (value: boolean) => { failDelete = value; },
    lostDeleteAck: (value: boolean) => { lostDeleteAck = value; }, unknown: (value: boolean) => { unknown = value; },
    failRead: (value: boolean) => { failRead = value; },
    holdGet: (enter: () => void, release: Promise<void>) => { heldGet = { enter, release }; },
    holdDelete: (enter: () => void, release: Promise<void>) => { heldDelete = { enter, release }; },
    async close() { controllers.forEach(c => c.dispose()); await port().load().catch(() => {}); server.stop(true); },
  };
}

test("an actual cold profile editor can recover identifiable corrupt saved contents only after explicit confirmation", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), raw = f.values.get(key), before = f.mutations(), c = await f.open();
    await c.discard(); await c.reload(); await c.flushRecovery();
    expect(c.getState().recovery?.ready).toBe(false); expect(c.getState().canSave).toBe(false);
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before); expect(f.patches).toHaveLength(0);
    expect(c.getState().recovery?.canReviewInvalid).toBe(true);
    await c.reviewInvalidRecovery(); expect(c.getState().recovery?.invalidReview).toBe(true);
    c.cancelInvalidRecoveryReview(); expect(f.values.get(key)).toBe(raw);
    await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(f.values.has(key)).toBe(false); expect(c.getState().recovery?.ready).toBe(true);
    expect(c.getState().draft.name).toBe("Canonical Name"); expect(f.patches).toHaveLength(0);
    c.setField("name", "復帰して保存する表示名"); await c.save(); expect(f.patches).toEqual([{ name: "復帰して保存する表示名" }]);
  } finally { await f.close(); }
});

for (const action of ["review", "discard"] as const) test(`retirement during ${action} state publication prevents dispatch into private storage`, async () => {
  const f = fixture(); let armed = false, c: Awaited<ReturnType<typeof f.open>> | undefined;
  try {
    const key = await f.seed(), raw = f.values.get(key), before = f.mutations();
    c = await f.open(() => {
      if (armed && (action === "review" ? c?.getState().recovery?.reviewingInvalid : c?.getState().recovery?.discardingInvalid)) { armed = false; c?.pause(); }
    });
    if (action === "discard") await c.reviewInvalidRecovery();
    const reads = f.reads(); armed = true;
    if (action === "review") await c.reviewInvalidRecovery(); else await c.discardInvalidRecovery();
    expect(c.getState().visible).toBe(false); expect(f.reads()).toBe(reads);
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before); expect(f.patches).toHaveLength(0);
  } finally { await f.close(); }
});

test("warm recovery preserves rich fields and a real uploaded image, including input typed during local discard", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const c = await f.open(); c.setField("name", "画面の表示名"); c.setField("summary", "画面の自己紹介");
    c.setField("fields", [{ name: "個人の項目", value: "https://example.test/profile" }]);
    await c.pickImage("icon_url", new File([new Uint8Array([137,80,78,71])], "保持する画像.png", { type: "image/png" }));
    await c.flushRecovery(); const key = f.corrupt(), raw = f.values.get(key); await c.flushRecovery();
    await c.reviewInvalidRecovery(); c.setField("name", "確認後の新しい表示名"); await c.discardInvalidRecovery();
    expect(f.values.get(key)).toBe(raw); expect(c.getState().recovery?.invalidReview).toBe(false);
    await c.reviewInvalidRecovery(); f.holdDelete(entered.resolve, release.promise);
    const clearing = c.discardInvalidRecovery(); await entered.promise;
    c.setField("summary", "破棄中も保持する自己紹介");
    await c.pickImage("header_url", new File([new Uint8Array([137,80,78,71])], "処理中は送らない.png", { type: "image/png" }));
    expect(f.uploads()).toBe(1); release.resolve(); await clearing;
    expect(c.getState()).toMatchObject({ draft: { name: "確認後の新しい表示名", summary: "破棄中も保持する自己紹介", fields: [{ name: "個人の項目", value: "https://example.test/profile" }], icon_url: "/media/aa.png" }, uploads: { icon_url: { phase: "ready", name: "保持する画像.png" } }, canSave: true });
    expect(f.patches).toHaveLength(0); await c.save();
    expect(f.patches).toEqual([{ name: "確認後の新しい表示名", summary: "破棄中も保持する自己紹介", fields: [{ name: "個人の項目", value: "https://example.test/profile" }], icon_url: "/media/aa.png" }]);
    expect(f.uploads()).toBe(1);
  } finally { release.resolve(); await f.close(); }
});

test("corrupt-record recovery preserves an unknown original PUT and requires review without replay", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("name", "結果不明の元の表示名"); f.unknown(true); await c.save();
    expect(c.getState().uncertain).toBe(true); expect(f.patches).toHaveLength(1);
    c.setField("name", "元とは別の新しい表示名"); await c.flushRecovery(); f.corrupt(); await c.flushRecovery();
    await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(c.getState()).toMatchObject({ draft: { name: "元とは別の新しい表示名" }, uncertain: true, canSave: false,
      recovery: { attempted: { patch: { name: "結果不明の元の表示名" } }, canConfirmReview: true } });
    expect(f.patches).toHaveLength(1); await c.confirmRecoveryReview(); expect(f.patches).toHaveLength(1);
    f.unknown(false); await c.save(); expect(f.patches).toEqual([{ name: "結果不明の元の表示名" }, { name: "元とは別の新しい表示名" }]);
  } finally { await f.close(); }
});

test("an image choice invalidates an open confirmation, and valid expired receipts remain ordinary recovery data", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("name", "画像と一緒に保持する名前"); await c.flushRecovery(); const key = f.corrupt(); await c.flushRecovery();
    await c.reviewInvalidRecovery(); await c.pickImage("icon_url", new File([new Uint8Array([137,80,78,71])], "確認後の画像.png", { type: "image/png" }));
    expect(c.getState().recovery?.invalidReview).toBe(false); await c.discardInvalidRecovery();
    expect(f.values.has(key)).toBe(true); expect(f.uploads()).toBe(1);
    await c.reviewInvalidRecovery(); await c.discardInvalidRecovery(); await c.flushRecovery();
    const saved = JSON.parse(f.values.get(key)!); saved.data.images.icon_url.upload.expiresAt = new Date(Date.now() - 1000).toISOString();
    f.values.set(key, JSON.stringify(saved)); const raw = f.values.get(key), before = f.mutations();
    await expect(f.port().reviewInvalid()).rejects.toMatchObject({ code: "changed" });
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before);
    c.dispose(); const restored = await f.open();
    expect(restored.getState()).toMatchObject({ uploads: { icon_url: { phase: "reselect" } }, canSave: false });
    expect(f.uploads()).toBe(1); expect(f.patches).toHaveLength(0);
  } finally { await f.close(); }
});

test("unreadable headers, foreign scopes, unknown formats and temporarily invalid input cannot authorize discard", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), data = JSON.parse(f.values.get(key)!);
    const form = { name: " ", summary: "", icon_url: "https://", header_url: "", is_private: false, fields: [] };
    for (const raw of ["not-json", JSON.stringify({ ...data, version: 2 }), JSON.stringify({ ...data, scope: "other" }),
      JSON.stringify({ ...data, savedAt: Date.now() + 60_000 }), JSON.stringify({ ...data, unexpected: true }),
      JSON.stringify({ ...data, data: { base: form, draft: form } })]) {
      f.values.set(key, raw); const before = f.mutations(); await expect(f.port().reviewInvalid()).rejects.toThrow();
      expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before);
    }
    expect(f.patches).toHaveLength(0); expect(f.uploads()).toBe(0);
  } finally { await f.close(); }
});

for (const warm of [false, true]) test(`${warm ? "warm" : "cold"} editor preserves a valid replacement record from stale confirmation`, async () => {
  const f = fixture();
  try {
    let c: Awaited<ReturnType<typeof f.open>>, key: string;
    if (warm) { c = await f.open(); c.setField("name", "この画面の入力"); await c.flushRecovery(); key = f.corrupt(); await c.flushRecovery(); }
    else { key = await f.seed(); c = await f.open(); }
    await c.reviewInvalidRecovery(); const other = f.port(); await (await other.reviewInvalid()).discard();
    const base: MobileProfileForm = { name: "Canonical Name", summary: "Canonical summary", icon_url: "", header_url: "", is_private: false, fields: [] };
    await other.save({ base, draft: { ...base, name: "別のAppで保存した新しい表示名" } }); const raw = f.values.get(key);
    await c.discardInvalidRecovery(); expect(f.values.get(key)).toBe(raw); expect(c.getState().canSave).toBe(false);
    await c.reload();
    expect(c.getState().draft.name).toBe(warm ? "この画面の入力" : "別のAppで保存した新しい表示名");
    if (warm) { c.pause(); await other.load(); expect(f.values.get(key)).toBe(raw); c.dispose(); await other.load(); expect(f.values.get(key)).toBe(raw); }
    expect(f.patches).toHaveLength(0);
  } finally { await f.close(); }
});

for (const warm of [false, true]) test(`${warm ? "warm" : "cold"} delete failure and lost local ACK preserve gating until an explicit read`, async () => {
  const f = fixture();
  try {
    let c: Awaited<ReturnType<typeof f.open>>, key: string;
    if (warm) { c = await f.open(); c.setField("name", "画面に保持する名前"); await c.flushRecovery(); key = f.corrupt(); await c.flushRecovery(); }
    else { key = await f.seed(); c = await f.open(); }
    const raw = f.values.get(key), before = f.mutations();
    f.failGet(true); await c.reviewInvalidRecovery(); expect(c.getState().recovery?.invalidReview).toBe(false);
    f.failGet(false); await c.reviewInvalidRecovery(); f.failDelete(true); await c.discardInvalidRecovery();
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before); expect(c.getState().canSave).toBe(false);
    f.failDelete(false); f.lostDeleteAck(true); await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(f.values.has(key)).toBe(false); expect(c.getState().canSave).toBe(false); expect(c.getState().recovery?.error).toBeTruthy();
    f.lostDeleteAck(false); await c.reload(); expect(c.getState().recovery?.ready).toBe(true); expect(c.getState().recovery?.error).toBe("");
    expect(c.getState().draft.name).toBe(warm ? "画面に保持する名前" : "Canonical Name");
    expect(f.patches).toHaveLength(0); expect(f.uploads()).toBe(0);
  } finally { await f.close(); }
});

for (const action of ["cancel", "pause", "dispose"] as const) test(`late review cannot revive local discard confirmation after ${action}`, async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const key = await f.seed(), raw = f.values.get(key), before = f.mutations(), c = await f.open();
    f.holdGet(entered.resolve, release.promise); const reviewing = c.reviewInvalidRecovery(); await entered.promise;
    if (action === "cancel") c.cancelInvalidRecoveryReview(); else if (action === "pause") c.pause(); else c.dispose();
    release.resolve(); await reviewing; await c.discardInvalidRecovery();
    expect(c.getState().recovery?.invalidReview).toBe(false); expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before); expect(f.patches).toHaveLength(0);
  } finally { release.resolve(); await f.close(); }
});

test("a successful local discard cannot authorize saving after canonical read failure", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), c = await f.open(); await c.reviewInvalidRecovery(); f.failRead(true); await c.discardInvalidRecovery();
    expect(f.values.has(key)).toBe(false); expect(c.getState()).toMatchObject({ canSave: false, needsReload: true });
    await c.save(); expect(f.patches).toHaveLength(0);
    f.failRead(false); await c.reload(); expect(c.getState()).toMatchObject({ loaded: true, draft: { name: "Canonical Name" }, recovery: { ready: true } });
  } finally { await f.close(); }
});

test("actual account namespace preserves other actors/APIs/feed and retirement rejects an old discard receipt", async () => {
  const f = fixture();
  try {
    const row = { id: "invalid_profile_row_A_001", product: "yurucommu" as const, hostUrl: f.session.hostUrl, lastUsedAt: f.session.createdAt }, fresh = { ...row, id: "invalid_profile_row_B_002" };
    const accounts = createFeedRecoveryAccounts({ store: f.store });
    const input = (selected = row) => ({ accounts: { activeId: selected.id, accounts: [selected] }, session: f.session });
    const select = (selected = row, scope = f.scope) => createProfileRecoveryStore({ store: accounts.accountStorage(input(selected)), scope });
    const base: MobileProfileForm = { name: "Current", summary: "", icon_url: "", header_url: "", is_private: false, fields: [] }, data = { base, draft: { ...base, name: "Saved" } };
    const old = select(); await old.save(data);
    const [envelopeKey, envelopeRaw] = [...f.values].find(([, raw]) => Object.hasOwn(JSON.parse(raw), "entries"))!;
    const envelope = JSON.parse(envelopeRaw), key = envelope.entries[0][0];
    const corrupt = () => { const v = JSON.parse(f.values.get(envelopeKey)!), tuple = v.entries.find(([name]: [string,string]) => name === key), value = JSON.parse(tuple[1]); value.data.draft.name = 123; tuple[1] = JSON.stringify(value); f.values.set(envelopeKey, JSON.stringify(v)); };
    corrupt(); const others = [select(row, { ...f.scope, actorApId: f.session.hostUrl + "/users/other" }), select(row, { ...f.scope, apiBaseUrl: f.session.hostUrl + "/alternate/api" }), select(fresh)];
    for (const other of others) await other.save(data);
    const feed = accounts.select({ ...input(), actorApId: f.scope.actorApId }); await feed.save({ content: "Keep composer", visibility: "public", attachments: [] });
    await (await old.reviewInvalid()).discard(); expect(await old.load()).toBe(null); expect((await feed.load())?.content).toBe("Keep composer");
    for (const other of others) expect((await other.load())?.draft.name).toBe("Saved");
    await old.save(data); corrupt(); const stale = await old.reviewInvalid(); await accounts.retire(row); const after = [...f.values];
    await expect(stale.discard()).rejects.toThrow(); expect([...f.values]).toEqual(after); expect((await others.at(-1)!.load())?.draft.name).toBe("Saved");
  } finally { await f.close(); }
});
