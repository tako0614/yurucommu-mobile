import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createFeedRecoveryAccounts } from "../src/feed-recovery.ts";
const row = { id: "saved_account_A_001", hostUrl: "https://recovery.example", product: "yurucommu" as const };
const scope = { product: "yurucommu" as const, hostUrl: row.hostUrl, actorApId: "https://recovery.example/users/me" };
function secureStore() {
  const values = new Map<string, string>();
  return { kind: "secure" as const, async get(key: string) { return values.get(key); },
    async set(key: string, raw: string) { values.set(key, raw); }, async delete(key: string) { values.delete(key); } } satisfies MobileSecureStore;
}
test("a real saved row restores its feed draft and audience without exposing them to a fresh same-person row", async () => {
  const store = secureStore(), first = createFeedRecoveryAccounts({ store });
  const data = { content: "再起動後の投稿下書き", visibility: "followers" as const, attachments: [] };
  await first.bind(row, scope).save(data);
  const restarted = createFeedRecoveryAccounts({ store: { ...store } });
  expect(await restarted.bind(row, scope).load()).toEqual(data);
  expect(await restarted.bind({ ...row, id: "saved_account_B_002" }, scope).load()).toBeNull();
});


test("corrupt private bytes cannot be loaded or overwritten by a replacement draft", async () => {
  const base = secureStore(); let corrupt = false, writes = 0;
  const store: MobileSecureStore = { ...base, async get(key) { return corrupt ? "not-json" : base.get(key); },
    async set(key, raw) { writes++; await base.set(key, raw); } };
  // A scope port exposes the actual storage codec independently of the row envelope.
  const { createFeedRecoveryStore } = await import("../src/feed-recovery.ts");
  const recovery = createFeedRecoveryStore({ store, scope });
  const data = { content: "保持する元の本文", visibility: "followers" as const, attachments: [] };
  await recovery.save(data); const before = writes; corrupt = true;
  await expect(recovery.load()).rejects.toMatchObject({ code: "invalid-data" });
  await expect(recovery.save({ ...data, content: "上書きしない" })).rejects.toMatchObject({ code: "invalid-data" });
  expect(writes).toBe(before); corrupt = false; expect(await recovery.load()).toEqual(data);
});


test("selection requires the canonical saved host and subject while actor and API data stay isolated", async () => {
  const factory = createFeedRecoveryAccounts({ store: secureStore() });
  const account = { ...row, accountId: "subject-one", lastUsedAt: "2026-11-11T00:00:00Z" };
  const session = { product: "yurucommu" as const, hostUrl: row.hostUrl, accountId: "subject-one", accessToken: "synthetic",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const data = { content: "本人の下書き", visibility: "unlisted" as const, attachments: [] };
  await factory.select({ accounts: { activeId: row.id, accounts: [account] }, session, actorApId: scope.actorApId }).save(data);
  expect(await factory.bind(row, { ...scope, actorApId: "other" }).load()).toBeNull();
  expect(await factory.bind(row, { ...scope, apiBaseUrl: row.hostUrl + "/other-api" }).load()).toBeNull();
  for (const changed of [{ ...account, accountId: "different" }, { ...account, hostUrl: "https://other.example" }, { ...account, product: "takos" as const }]) {
    expect(() => factory.select({ accounts: { activeId: row.id, accounts: [changed] }, session, actorApId: scope.actorApId })).toThrow();
  }
  expect(await factory.bind(row, scope).load()).toEqual(data);
});

test("failed retirement stays discoverable after restart and preserves inactive or fresh same-person rows", async () => {
  const base = secureStore(); let fail = false;
  const store: MobileSecureStore = { ...base, async delete(key) { if (fail) throw new Error("synthetic purge failure"); await base.delete(key); } };
  const factory = createFeedRecoveryAccounts({ store }), b = { ...row, id: "saved_account_B_002" };
  const data = { content: "古い行", visibility: "followers" as const, attachments: [] };
  await factory.bind(row, scope).save(data); await factory.bind(b, scope).save({ ...data, content: "新しい行" });
  // Absence alone is not a deletion intent, including a normalized empty list.
  expect(await factory.pendingCleanup({ accounts: [] })).toEqual([]);
  fail = true; await expect(factory.retire(row)).rejects.toThrow();
  const restarted = createFeedRecoveryAccounts({ store: { ...store } });
  expect(await restarted.pendingCleanup({ accounts: [] })).toEqual([row]);
  const current = (value: typeof row) => ({ ...value, lastUsedAt: "2026-11-11T00:00:00Z" });
  expect(await restarted.pendingCleanup({ accounts: [current(row), current(b)] })).toEqual([]);
  fail = false; await restarted.retire(row);
  expect(await restarted.pendingCleanup({ accounts: [] })).toEqual([]);
  expect(await restarted.bind(b, scope).load()).toEqual({ ...data, content: "新しい行" });
  expect(() => factory.bind(row, scope)).toThrow();
});

test("retirement fences old queued writes and concurrent row metadata updates do not lose a sibling", async () => {
  const base = secureStore(); let hold = true, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(yes => { enter = yes; }), released = new Promise<void>(yes => { release = yes; });
  const store: MobileSecureStore = { ...base, async set(key, raw) {
    if (hold && key.includes(":account:v1:")) { hold = false; enter(); await released; } await base.set(key, raw);
  } };
  const factory = createFeedRecoveryAccounts({ store }), a = factory.bind(row, scope), bRow = { ...row, id: "saved_account_B_002" };
  const b = factory.bind(bRow, scope), data = { content: "A書込中", visibility: "followers" as const, attachments: [] };
  const first = a.save(data).catch(error => error); await entered;
  const queued = a.save({ ...data, content: "A待機中" }).catch(error => error);
  const retired = factory.retire(row); const sibling = b.save({ ...data, content: "B保持" }); release();
  const results = await Promise.all([first, queued, retired, sibling]);
  expect(results[0]).toBeInstanceOf(Error); expect(results[1]).toBeInstanceOf(Error);
  expect(await b.load()).toEqual({ ...data, content: "B保持" });
  const restarted = createFeedRecoveryAccounts({ store: { ...store } });
  expect(await restarted.bind(row, scope).load()).toBeNull();
  expect(await restarted.pendingCleanup({ accounts: [] })).toEqual([]);
});

test("invalid snapshots and media cannot replace protected work or fall back to plaintext", async () => {
  const { createFeedRecoveryStore } = await import("../src/feed-recovery.ts");
  const store = secureStore(), recovery = createFeedRecoveryStore({ store, scope });
  const data = { content: "元の下書き", visibility: "followers" as const, attachments: [] }; await recovery.save(data);
  for (const invalid of [{ ...data, accessToken: "synthetic-never-persist" }, { ...data, content: "x".repeat(501) },
    { ...data, attachments: [{ phase: "ready", upload: { name: "a.png", content_type: "image/png", url: "https://foreign.example/media/aa.png", r2_key: "uploads/aa.png" } }] }]) {
    await expect(recovery.save(invalid as never)).rejects.toThrow(); expect(await recovery.load()).toEqual(data);
  }
  expect(() => createFeedRecoveryAccounts({ store: { ...store, kind: "device-persistent" } as never })).toThrow();
  expect(() => createFeedRecoveryStore({ store, scope: { ...scope, accessToken: "synthetic-never-persist" } as never })).toThrow();
});


test("completed or explicitly cleared reply scopes release capacity without evicting drafts", async () => {
  const store = secureStore(), accounts = createFeedRecoveryAccounts({store});
  const keep = accounts.bind(row, scope), data = {content:"protected",visibility:"public" as const,attachments:[]};
  await keep.save(data);
  for (let i=0;i<40;i++) {
    const apId = row.hostUrl + "/posts/" + i;
    const port = accounts.bind(row,{...scope,replyParentApId:apId});
    const reply = {target:{apId,communityApId:null,visibility:"public" as const},audienceConfirmed:true};
    await port.save({...data,reply});
    await port.save({...data,content:"",reply});
    expect(await port.load()).toBeNull();
  }
  expect(await keep.load()).toEqual(data);
});
