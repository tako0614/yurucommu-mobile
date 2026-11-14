import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import type { MobileProfileForm } from "../src/profile-edit-api.ts";
import { createFeedRecoveryAccounts } from "../src/feed-recovery.ts";
import { createProfileRecoveryStore } from "../src/profile-recovery.ts";
import { createProfileEditController } from "../src/profile-edit-controller.ts";

function fixture() {
  let puts = 0, uploads = 0, mediaTTL = 3600_000, unknown = false, readFailure = false, writeFailure = false, afterAckFailure = false;
  let canonical: MobileProfileForm = { name: "Canonical Name", summary: "Canonical summary", icon_url: "", header_url: "", is_private: false, fields: [] };
  const values = new Map<string, string>();
  let heldWrite: { entered: () => void; release: Promise<void> } | undefined;
  let heldActorRead: { entered: () => void; release: Promise<void> } | undefined;
  const patches: Partial<MobileProfileForm>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname, id = server.url.origin + "/users/me";
    const actor = { ap_id: id, preferred_username: "me", ...canonical };
    if (request.method === "GET" && (path === "/api/auth/me" || path === "/api/actors/" + encodeURIComponent(id))) {
      if (path !== "/api/auth/me" && heldActorRead) { const held = heldActorRead; heldActorRead = undefined; held.entered(); await held.release; }
      return readFailure ? new Response("synthetic read failure", { status: 503 }) : Response.json({ actor });
    }
    if (request.method === "PUT" && path === "/api/actors/me") {
      puts++; const patch = await request.json() as Partial<MobileProfileForm>; patches.push(patch); canonical = { ...canonical, ...patch };
      return unknown ? new Response("synthetic unknown after actual fixture write", { status: 503 }) : Response.json({ success: true });
    }
    if (request.method === "POST" && path === "/api/media/upload") {
      uploads++; await request.formData(); return Response.json({ r2_key: "uploads/aa.png", url: "/media/aa.png", content_type: "image/png", expires_at: new Date(Date.now() + mediaTTL).toISOString() });
    }
    return new Response("unexpected fixture request", { status: 404 });
  } });
  const session = { hostUrl: server.url.origin, product: "yurucommu" as const, tokenType: "Bearer", accessToken: "synthetic-local-only", createdAt: "2026-11-11T00:00:00Z" };
  const store: MobileSecureStore = { kind: "secure", async get(key) { return values.get(key); },
    async set(key, raw) {
      if (heldWrite) { const held = heldWrite; heldWrite = undefined; held.entered(); await held.release; }
      if (writeFailure || (afterAckFailure && puts > 0)) throw new Error("synthetic private write failure"); values.set(key, raw);
    }, async delete(key) { values.delete(key); } };
  const actorApId = server.url.origin + "/users/me";
  const controllers: ReturnType<typeof createProfileEditController>[] = [];
  return { session, store, actorApId, patches,
    async open(confirmDiscard?: () => boolean) {
      const { createProfileRecoveryStore } = await import("../src/profile-recovery.ts");
      const controller = createProfileEditController({ session, confirmDiscard, recovery: () => createProfileRecoveryStore({ store,
        scope: { product: "yurucommu", hostUrl: session.hostUrl, actorApId } }) });
      controllers.push(controller); await controller.show(actorApId); return controller;
    },
    unknown: (value: boolean) => { unknown = value; }, refuseRead: (value: boolean) => { readFailure = value; },
    failWrites: (value: boolean) => { writeFailure = value; }, failAfterAck: (value: boolean) => { afterAckFailure = value; },
    remote: (patch: Partial<MobileProfileForm>) => { canonical = { ...canonical, ...patch }; },
    mediaTTL: (value: number) => { mediaTTL = value; },
    holdWrite: (entered: () => void, release: Promise<void>) => { heldWrite = { entered, release }; },
    holdActorRead: (entered: () => void, release: Promise<void>) => { heldActorRead = { entered, release }; },
    counts: () => ({ puts, uploads }), close() { controllers.forEach(c => c.dispose()); server.stop(true); },
  };
}
test("the actual profile editor restores unsent fields against canonical values without another PUT", async () => {
  const f = fixture();
  try {
    const first = await f.open(); first.setField("name", "終了後に戻す表示名"); await first.flushRecovery(); first.dispose();
    const next = await f.open(); expect(next.getState()).toMatchObject({ draft: { name: "終了後に戻す表示名", summary: "Canonical summary" }, canSave: true });
    expect(f.counts().puts).toBe(0);
  } finally { f.close(); }
});

test("confirmed discard persists the reset while preserving fields edited during its canonical GET", async () => {
  const f = fixture(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(yes => { enter = yes; }), released = new Promise<void>(yes => { release = yes; });
  let discarding: Promise<boolean> | undefined;
  try {
    const c = await f.open(() => true); c.setField("name", "破棄する元の名前"); c.setField("summary", "破棄する元の自己紹介"); await c.flushRecovery();
    f.holdActorRead(enter, released); discarding = c.discard(); await entered; c.setField("name", "再読取中の新しい名前"); release(); await discarding;
    expect(c.getState().draft).toMatchObject({ name: "再読取中の新しい名前", summary: "Canonical summary" });
    await c.flushRecovery(); c.dispose(); const next = await f.open();
    expect(next.getState().draft).toMatchObject({ name: "再読取中の新しい名前", summary: "Canonical summary" }); expect(f.counts().puts).toBe(0);
  } finally { release(); await discarding; f.close(); }
});

test("corrupt secure data refuses both restore and replacement while preserving the original bytes", async () => {
  const f = fixture(); let corrupt = false, writes = 0;
  try {
    const store: MobileSecureStore = { ...f.store, async get(key) { return corrupt ? "invalid-json" : f.store.get(key); },
      async set(key, raw) { writes++; await f.store.set(key, raw); } };
    const port = createProfileRecoveryStore({ store, scope: { product: "yurucommu", hostUrl: f.session.hostUrl, actorApId: f.actorApId } });
    const form: MobileProfileForm = { name: "保持する名前", summary: "", icon_url: "", header_url: "", is_private: false, fields: [] };
    const data = { base: form, draft: { ...form, name: "保持する元入力" } }; await port.save(data); const before = writes; corrupt = true;
    await expect(port.load()).rejects.toMatchObject({ code: "invalid-data" });
    await expect(port.save({ ...data, draft: { ...form, name: "上書きしない" } })).rejects.toMatchObject({ code: "invalid-data" });
    expect(writes).toBe(before); corrupt = false; expect(await port.load()).toEqual(data);
    await expect(port.save({ ...data, draft: { ...data.draft, accessToken: "must-not-store" } } as typeof data)).rejects.toMatchObject({ code: "invalid-data" });
  } finally { f.close(); }
});

test("the actual editor rejects recovery from a different actor, host or API before reading private bytes", async () => {
  const f = fixture(); let reads = 0;
  const controllers: ReturnType<typeof createProfileEditController>[] = [];
  try {
    const store = { ...f.store, async get(key: string) { reads++; return f.store.get(key); } };
    for (const change of [{ actorApId: f.session.hostUrl + "/users/other" }, { hostUrl: "https://other.fixture.test" }, { apiBaseUrl: f.session.hostUrl + "/other-api" }]) {
      const port = createProfileRecoveryStore({ store, scope: { product: "yurucommu", hostUrl: f.session.hostUrl, actorApId: f.actorApId, ...change } });
      const c = createProfileEditController({ session: f.session, recovery: () => port }); controllers.push(c); await c.show(f.actorApId);
      expect(c.getState().canSave).toBe(false); expect(c.getState().recovery?.ready).toBe(false);
    }
    expect(reads).toBe(0); expect(f.counts().puts).toBe(0);
  } finally { controllers.forEach(c => c.dispose()); f.close(); }
});

test("canonical saved-row retirement covers profile and feed while retaining a fresh same-person row", async () => {
  const f = fixture(); let fail = true;
  try {
    const store = { ...f.store, async delete(key: string) { if (fail) throw new Error("synthetic cleanup failure"); await f.store.delete(key); } };
    const accounts = createFeedRecoveryAccounts({ store });
    const row = { id: "saved_profile_A_001", product: "yurucommu" as const, hostUrl: f.session.hostUrl, lastUsedAt: "2026-11-11T00:00:00Z" };
    const fresh = { ...row, id: "saved_profile_B_002" };
    const input = { session: f.session, accounts: { activeId: row.id, accounts: [row] } }, scope = { product: "yurucommu" as const, hostUrl: f.session.hostUrl, actorApId: f.actorApId };
    const port = createProfileRecoveryStore({ store: accounts.accountStorage(input), scope });
    const base: MobileProfileForm = { name: "現在の名前", summary: "", icon_url: "", header_url: "", is_private: false, fields: [] };
    await port.save({ base, draft: { ...base, name: "古い行の入力" } });
    await accounts.select({ ...input, actorApId: f.actorApId }).save({ content: "ホーム入力", visibility: "public", attachments: [] });
    const freshPort = createProfileRecoveryStore({ store: accounts.accountStorage({ ...input, accounts: { activeId: fresh.id, accounts: [fresh] } }), scope });
    await freshPort.save({ base, draft: { ...base, name: "新しい行の入力" } });
    expect(await accounts.pendingCleanup({ accounts: [] })).toEqual([]);
    await expect(accounts.retire(row)).rejects.toThrow();
    const restarted = createFeedRecoveryAccounts({ store: { ...store } });
    expect(await restarted.pendingCleanup({ accounts: [] })).toEqual([{ id: row.id, product: row.product, hostUrl: row.hostUrl }]);
    fail = false; await restarted.retire(row); expect(await restarted.pendingCleanup({ accounts: [] })).toEqual([]);
    expect((await freshPort.load())?.draft.name).toBe("新しい行の入力"); await expect(port.load()).rejects.toThrow();
    expect(() => accounts.accountStorage({ ...input, accounts: { activeId: row.id, accounts: [{ ...row, accountId: "different-subject" }] } })).toThrow();
  } finally { f.close(); }
});

test("input during a held pre-PUT checkpoint remains newer than the acknowledged original patch", async () => {
  const f = fixture(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(yes => { enter = yes; }), released = new Promise<void>(yes => { release = yes; });
  let saving: Promise<boolean> | undefined;
  try {
    const c = await f.open(); c.setField("name", "送信する元の名前"); f.holdWrite(enter, released); saving = c.save(); await entered;
    expect(f.counts().puts).toBe(0); c.setField("name", "保存待ちに書いた次の名前"); release(); await saving;
    expect(f.patches).toEqual([{ name: "送信する元の名前" }]);
    expect(c.getState()).toMatchObject({ draft: { name: "保存待ちに書いた次の名前" }, uncertain: false, dirty: true });
    await c.flushRecovery(); c.dispose(); const next = await f.open();
    expect(next.getState().draft.name).toBe("保存待ちに書いた次の名前"); expect(f.counts().puts).toBe(1);
  } finally { release(); await saving; f.close(); }
});

test("an image that expires while the original checkpoint waits cannot reach PUT", async () => {
  const f = fixture(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(yes => { enter = yes; }), released = new Promise<void>(yes => { release = yes; });
  let saving: Promise<boolean> | undefined;
  try {
    f.mediaTTL(700); const c = await f.open(); c.setField("name", "期限を確認する画像");
    await c.pickImage("icon_url", new File([new Uint8Array([137,80,78,71])], "保存待ち画像.png", { type: "image/png" }));
    await c.flushRecovery(); f.holdWrite(enter, released); saving = c.save(); await entered;
    await Bun.sleep(800); release(); await saving;
    expect(f.counts()).toEqual({ puts: 0, uploads: 1 }); expect(c.getState()).toMatchObject({ uncertain: false, canSave: false });
    c.dispose(); const next = await f.open();
    expect(next.getState()).toMatchObject({ uploads: { icon_url: { phase: "reselect" } }, uncertain: false, canSave: false });
    expect(next.getState().recovery?.attempted).toBeUndefined(); expect(f.counts()).toEqual({ puts: 0, uploads: 1 });
  } finally { release(); await saving; f.close(); }
});

test("partially typed invalid image URLs survive recovery while the existing API validator still refuses save", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("name", "入力を続ける名前"); c.setField("icon_url", "https://"); await c.flushRecovery(); c.dispose();
    const next = await f.open(); expect(next.getState()).toMatchObject({ draft: { icon_url: "https://", name: "入力を続ける名前" }, canSave: false });
    expect(next.getState().validation).not.toBe(""); await next.save(); expect(f.counts().puts).toBe(0);
    next.setField("icon_url", ""); expect(next.getState().canSave).toBe(true);
  } finally { f.close(); }
});

test("a valid restored image keeps its real receipt while expiry requires reselection without another upload", async () => {
  const f = fixture();
  try {
    f.mediaTTL(1000); const first = await f.open(); first.setField("name", "画像付きプロフィール");
    await first.pickImage("icon_url", new File([new Uint8Array([137,80,78,71])], "選んだ画像.png", { type: "image/png" }));
    await first.flushRecovery(); first.dispose(); const restored = await f.open();
    expect(restored.getState()).toMatchObject({ uploads: { icon_url: { phase: "ready", name: "選んだ画像.png" } }, canSave: true });
    expect(f.counts()).toEqual({ puts: 0, uploads: 1 }); restored.dispose();
    await Bun.sleep(1100); const expired = await f.open();
    expect(expired.getState()).toMatchObject({ draft: { name: "画像付きプロフィール" }, uploads: { icon_url: { phase: "reselect" } }, canSave: false });
    await expired.save(); expect(f.counts()).toEqual({ puts: 0, uploads: 1 });
    expired.restoreImage("icon_url"); await expired.flushRecovery(); expect(expired.getState().canSave).toBe(true);
  } finally { f.close(); }
});

test("pre-change checkpoint failure prevents PUT and confirmed ACK survives failed final persistence", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setField("name", "保存してから変更する"); f.failWrites(true); await c.save();
    expect(f.counts().puts).toBe(0); expect(c.getState()).toMatchObject({ draft: { name: "保存してから変更する" }, uncertain: false, canSave: false });
    f.failWrites(false); await c.flushRecovery(); f.failAfterAck(true); await c.save();
    expect(c.getState()).toMatchObject({ message: "プロフィールを保存しました。", uncertain: false, canSave: false });
    expect(f.counts().puts).toBe(1); c.setField("name", "ACK後の新しい入力"); await c.save(); expect(f.counts().puts).toBe(1);
    f.failAfterAck(false); await c.flushRecovery(); c.dispose(); const next = await f.open();
    expect(next.getState()).toMatchObject({ draft: { name: "ACK後の新しい入力" }, uncertain: false, canSave: true }); expect(f.counts().puts).toBe(1);
  } finally { f.close(); }
});

test("unknown original profile patch and newer input survive restart and need successful read plus explicit review", async () => {
  const f = fixture();
  try {
    const first = await f.open(); first.setField("name", "結果不明の元変更"); f.unknown(true); await first.save();
    first.setField("name", "後から入力した名前"); await first.flushRecovery(); first.dispose();
    const next = await f.open(); expect(next.getState()).toMatchObject({ draft: { name: "後から入力した名前" }, uncertain: true, canSave: false,
      recovery: { attempted: { draft: { name: "結果不明の元変更" }, patch: { name: "結果不明の元変更" } } } });
    await next.save(); expect(f.counts().puts).toBe(1);
    f.refuseRead(true); await next.reload(); await next.confirmRecoveryReview(); expect(next.getState().canSave).toBe(false);
    f.refuseRead(false); await next.reload(); expect(next.getState().recovery?.canConfirmReview).toBe(true);
    f.refuseRead(true); await next.reload(); expect(next.getState().recovery?.canConfirmReview).toBe(false);
    f.refuseRead(false); await next.reload();
    await next.confirmRecoveryReview(); expect(next.getState()).toMatchObject({ draft: { name: "後から入力した名前" }, uncertain: false, canSave: true });
    expect(f.counts().puts).toBe(1);
  } finally { f.close(); }
});

test("a cold draft keeps unrelated remote fields and requires review before overwriting a changed field", async () => {
  const f = fixture();
  try {
    const first = await f.open(); first.setField("name", "こちらの表示名下書き"); await first.flushRecovery(); first.dispose();
    f.remote({ name: "別の端末の表示名", summary: "別の端末の自己紹介" });
    const next = await f.open(); expect(next.getState()).toMatchObject({ draft: { name: "こちらの表示名下書き", summary: "別の端末の自己紹介" }, canSave: false,
      recovery: { conflicts: ["name"], current: { name: "別の端末の表示名" } } });
    await next.save(); expect(f.counts().puts).toBe(0);
    await next.reload(); await next.confirmRecoveryReview(); expect(next.getState().canSave).toBe(true);
    await next.flushRecovery(); next.dispose();
    const restored = await f.open(); expect(restored.getState()).toMatchObject({ draft: { name: "こちらの表示名下書き" }, canSave: true, recovery: { conflicts: [] } });
    expect(f.counts().puts).toBe(0);
  } finally { f.close(); }
});
