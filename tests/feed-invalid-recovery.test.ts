import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { loadHome, type MobilePostVisibility } from "../src/api.ts";
import { loadMobilePostReplies } from "../src/notification-api.ts";
import { createFeedController } from "../src/feed-controller.ts";
import { createFeedRecoveryAccounts, createFeedRecoveryStore, type FeedRecoveryScope } from "../src/feed-recovery.ts";
import { createNotificationController } from "../src/notification-controller.ts";

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() }; }
function fixture(reply = false, audience: MobilePostVisibility = "public") {
  const values = new Map<string,string>(), bodies: Record<string,unknown>[] = [];
  let mutations = 0, reads = 0, outcomes = 0, uploads = 0, failGet = false, failDelete = false, lostDeleteAck = false, refuseOutcome = false, unknown = false;
  let heldGet: { enter: () => void; release: Promise<void> } | undefined, heldDelete: typeof heldGet;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname, host = server.url.origin, actor = { ap_id: host + "/users/me", preferred_username: "me", name: null, icon_url: null };
    if (request.method === "GET") {
      if (path === "/api/auth/me") return refuseOutcome ? new Response("synthetic outcome read failure", { status: 503 }) : Response.json({ actor });
      if (path === "/api/timeline") { outcomes++; return Response.json({ posts: [], has_more: false, next_cursor: null }); }
      if (path === "/api/notifications/unread/count") return Response.json({ count: 0 });
      if (path.endsWith("/replies")) { outcomes++; return refuseOutcome ? new Response("synthetic outcome read failure", { status: 503 }) : Response.json({ replies: [], has_more: false, next_cursor: null }); }
      if (path === "/api/posts/" + encodeURIComponent(host + "/posts/parent")) return Response.json({ post: { ap_id: host + "/posts/parent", type: "Note", content: "Canonical parent", author: actor, visibility: target.visibility, community_ap_id: target.communityApId, published: "2026-11-11T00:00:00Z" } });
      if (path === "/api/posts/" + encodeURIComponent(host + "/ap/posts/saved")) {
        const body = bodies.at(-1)!; return Response.json({ post: { ap_id: host + "/ap/posts/saved", in_reply_to: body.in_reply_to, visibility: body.visibility, community_ap_id: body.community_ap_id ?? null, author: actor } });
      }
    }
    if (request.method === "POST" && path === "/api/posts") {
      bodies.push(await request.json() as Record<string,unknown>); return unknown ? new Response("synthetic unknown after write", { status: 503 }) : Response.json({ post: { ap_id: host + "/ap/posts/saved", author: actor } });
    }
    if (request.method === "POST" && path === "/api/media/upload") { uploads++; await request.formData(); return Response.json({ r2_key: "uploads/aa.png", url: "/media/aa.png", content_type: "image/png", expires_at: new Date(Date.now() + 3_600_000).toISOString() }); }
    return new Response("unexpected synthetic request", { status: 404 });
  } });
  const session = { product: "yurucommu" as const, hostUrl: server.url.origin, tokenType: "Bearer", accessToken: "synthetic-local-only", createdAt: "2026-11-11T00:00:00Z" };
  const target = { apId: session.hostUrl + "/posts/parent", communityApId: null, visibility: audience };
  const scope: FeedRecoveryScope = { product: "yurucommu", hostUrl: session.hostUrl, actorApId: session.hostUrl + "/users/me", ...(reply ? { replyParentApId: target.apId, replyView: "post" } : {}) };
  const store: MobileSecureStore = { kind: "secure", async get(key) { reads++; if (failGet) throw Error("synthetic storage read failure"); const raw = values.get(key); if (heldGet) { const held = heldGet; heldGet = undefined; held.enter(); await held.release; } return raw; },
    async set(key, raw) { mutations++; values.set(key,raw); }, async delete(key) { if (heldDelete) { const held = heldDelete; heldDelete = undefined; held.enter(); await held.release; } if (failDelete) throw Error("synthetic delete failure"); mutations++; values.delete(key); if (lostDeleteAck) throw Error("synthetic lost delete ACK"); } };
  const controllers: ReturnType<typeof createFeedController>[] = [], port = () => createFeedRecoveryStore({ store,scope });
  const data = () => ({ content: "保存した投稿下書き", visibility: reply ? target.visibility : "public" as const, attachments: [], ...(reply ? { reply: { target, audienceConfirmed: target.visibility !== "followers" } } : {}) });
  function corrupt() { const [key,raw] = [...values][0], value = JSON.parse(raw); value.data.content = 123; values.set(key,JSON.stringify(value)); return key; }
  return { values, bodies, session, scope, target, store, port, data, corrupt, mutations: () => mutations, reads: () => reads, outcomes: () => outcomes, uploads: () => uploads,
    async seed() { await port().save(data()); expect(await port().load()).toEqual(data()); return corrupt(); },
    async open(onChange?: () => void, outcomeAvailable = true) { const c = createFeedController({ session, recovery: port(), refreshHome: async () => {}, ...(outcomeAvailable ? { readRecoveryOutcome: async () => { if (reply) await loadMobilePostReplies(session,target.apId); else await loadHome(session); } } : {}), onChange, ...(reply ? { replyTo: target } : {}) }); controllers.push(c); await c.restoreRecovery(); return c; },
    failGet: (v: boolean) => { failGet = v; }, failDelete: (v: boolean) => { failDelete = v; }, lostDeleteAck: (v: boolean) => { lostDeleteAck = v; }, refuseOutcome: (v: boolean) => { refuseOutcome = v; }, unknown: (v: boolean) => { unknown = v; },
    holdGet: (enter: () => void, release: Promise<void>) => { heldGet = { enter,release }; }, holdDelete: (enter: () => void, release: Promise<void>) => { heldDelete = { enter,release }; },
    async close() { controllers.forEach(c => c.dispose()); await port().load().catch(() => {}); server.stop(true); },
  };
}

for (const reply of [false,true]) test(`${reply ? "reply" : "feed"} actual composer leaves corrupt-record wait only after scoped explicit recovery and a real outcome read`, async () => {
  const f = fixture(reply);
  try {
    const key = await f.seed(), raw = f.values.get(key), before = f.mutations(), c = await f.open();
    c.clearDraft(); await c.flushRecovery(); await c.restoreRecovery();
    expect(c.getState().recovery?.ready).toBe(false); expect(c.getState().canSubmit).toBe(false);
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before); expect(f.bodies).toHaveLength(0);
    expect(c.getState().recovery?.canReviewInvalid).toBe(true);
    await c.reviewInvalidRecovery(); expect(c.getState().recovery?.invalidReview).toBe(true); c.cancelInvalidRecoveryReview(); expect(f.values.get(key)).toBe(raw);
    await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(c.getState().recovery?.ready).toBe(true); expect(f.outcomes()).toBeGreaterThan(0); expect(f.bodies).toHaveLength(0);
    c.setDraft("復旧後に自分で送信する本文"); await c.submit();
    expect(f.bodies).toHaveLength(1); expect(f.bodies[0].content).toBe("復旧後に自分で送信する本文");
    if (reply) expect(f.bodies[0].in_reply_to).toBe(f.target.apId);
  } finally { await f.close(); }
});

test("a cold valid replacement survives stale discard and canonical read failure followed by explicit retry", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), c = await f.open(); await c.reviewInvalidRecovery();
    const other = f.port(); await (await other.reviewInvalid()).discard(); await other.save({ ...f.data(), content: "別のAppが保存した新しい本文" });
    const raw = f.values.get(key); await c.discardInvalidRecovery(); expect(f.values.get(key)).toBe(raw);
    f.refuseOutcome(true); await c.flushRecovery(); expect(c.getState().canSubmit).toBe(false); expect(f.values.get(key)).toBe(raw);
    f.refuseOutcome(false); await c.flushRecovery();
    expect(c.getState()).toMatchObject({ content: "別のAppが保存した新しい本文", canSubmit: true, recovery: { ready: true, discardPending: false } });
    expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});

for (const reply of [false,true]) test(`${reply ? "reply" : "feed"} warm recovery keeps newer text, selected audience and uploaded attachments`, async () => {
  const f = fixture(reply,"followers"), entered = deferred(), release = deferred();
  try {
    const c = await f.open(); c.setDraft("保持する元の下書き"); c.setVisibility("followers");
    await c.addFiles([new File([new Uint8Array([137,80,78,71])],"残す添付.png",{ type:"image/png" })]); await c.flushRecovery();
    const key = f.corrupt(), raw = f.values.get(key); await c.flushRecovery(); await c.reviewInvalidRecovery();
    c.setDraft("確認後の追加入力"); await c.discardInvalidRecovery(); expect(f.values.get(key)).toBe(raw);
    expect(c.getState().recovery?.invalidReview).toBe(false); await c.reviewInvalidRecovery();
    f.holdDelete(entered.resolve,release.promise); const clearing = c.discardInvalidRecovery(); await entered.promise;
    c.setDraft("破棄中も残る最後の本文"); await c.addFiles([new File([new Uint8Array([137,80,78,71])],"処理中は送らない.png",{ type:"image/png" })]);
    expect(f.uploads()).toBe(1); release.resolve(); await clearing;
    expect(c.getState()).toMatchObject({ content:"破棄中も残る最後の本文", visibility:"followers", canSubmit:true, attachments:[{ name:"残す添付.png",phase:"ready" }], recovery:{ discardPending:false } });
    expect(f.bodies).toHaveLength(0); await c.submit(); expect(f.bodies).toHaveLength(1); expect(f.bodies[0]).toMatchObject({ content:"破棄中も残る最後の本文",visibility:"followers" });
    expect(f.uploads()).toBe(1);
  } finally { release.resolve(); await f.close(); }
});

for (const reply of [false,true]) test(`${reply ? "reply" : "feed"} unknown original intent survives local discard and is never replayed or acknowledged by it`, async () => {
  const f = fixture(reply);
  try {
    const c = await f.open(); c.setDraft("応答不明の元の投稿"); f.unknown(true); await c.submit(); const original = c.getState().recovery?.intent;
    expect(original?.phase).toBe("uncertain"); c.setDraft("元の投稿とは別の新しい本文"); await c.flushRecovery(); f.corrupt(); await c.flushRecovery();
    await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(c.getState()).toMatchObject({ content:"元の投稿とは別の新しい本文",canSubmit:false,recovery:{ intent:original,canConfirmReview:true,discardPending:false } });
    expect(f.bodies).toHaveLength(1); await c.confirmRecoveryReview(); expect(f.bodies).toHaveLength(1); expect(c.getState().recovery?.intent).toBeUndefined();
    f.unknown(false); await c.submit(); expect(f.bodies).toHaveLength(2); expect(f.bodies[1].content).toBe("元の投稿とは別の新しい本文");
  } finally { await f.close(); }
});

for (const reply of [false,true]) for (const warm of [false,true]) test(`${reply ? "reply" : "feed"} ${warm ? "warm" : "cold"} storage/read failures and lost delete ACK require actual read recovery`, async () => {
  const f = fixture(reply);
  try {
    let c: Awaited<ReturnType<typeof f.open>>, key: string;
    if (warm) { c = await f.open(); c.setDraft("消さずに保持する本文"); await c.flushRecovery(); key = f.corrupt(); await c.flushRecovery(); }
    else { key = await f.seed(); c = await f.open(); }
    const raw = f.values.get(key), before = f.mutations(); f.failGet(true); await c.reviewInvalidRecovery();
    expect(c.getState().recovery?.invalidReview).toBe(false); expect(f.mutations()).toBe(before);
    f.failGet(false); await c.reviewInvalidRecovery(); f.failDelete(true); await c.discardInvalidRecovery(); expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before);
    f.failDelete(false); f.lostDeleteAck(true); await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(f.values.has(key)).toBe(false); expect(c.getState().recovery?.discardPending).toBe(true); expect(c.getState().canSubmit).toBe(false);
    f.lostDeleteAck(false); f.refuseOutcome(true); await c.flushRecovery(); expect(c.getState().canSubmit).toBe(false); expect(c.getState().recovery?.discardPending).toBe(true);
    f.refuseOutcome(false); await c.flushRecovery(); expect(c.getState().recovery).toMatchObject({ ready:true,discardPending:false,error:"" });
    expect(c.getState().content).toBe(warm ? "消さずに保持する本文" : ""); expect(f.bodies).toHaveLength(0);
    if (!warm) c.setDraft("再確認後の明示送信"); await c.submit(); expect(f.bodies).toHaveLength(1);
  } finally { await f.close(); }
});

for (const warm of [false,true]) test(`${warm ? "warm" : "cold"} stale confirmation never erases or implicitly overwrites a different valid saved draft`, async () => {
  const f = fixture();
  try {
    let c: Awaited<ReturnType<typeof f.open>>, key: string;
    if (warm) { c = await f.open(); c.setDraft("この画面に残す本文"); await c.flushRecovery(); key = f.corrupt(); await c.flushRecovery(); }
    else { key = await f.seed(); c = await f.open(); }
    await c.reviewInvalidRecovery(); const other = f.port(); await (await other.reviewInvalid()).discard(); await other.save({ ...f.data(),content:"別のAppの新しい保存" });
    const raw = f.values.get(key); await c.discardInvalidRecovery(); expect(f.values.get(key)).toBe(raw); expect(c.getState().canSubmit).toBe(false);
    if (warm) { await c.flushRecovery(); expect(c.getState().content).toBe("この画面に残す本文"); c.pause(); await other.load(); expect(f.values.get(key)).toBe(raw); c.dispose(); await other.load(); expect(f.values.get(key)).toBe(raw); }
    else { await c.restoreRecovery(); expect(c.getState()).toMatchObject({ content:"別のAppの新しい保存",canSubmit:true }); }
    expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});

test("unknown headers and valid partial input or expired attachment receipts cannot authorize discard", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), data = JSON.parse(f.values.get(key)!);
    for (const raw of ["not JSON",JSON.stringify({ ...data,version:2 }),JSON.stringify({ ...data,scope:"foreign" }),JSON.stringify({ ...data,savedAt:Date.now()+60_000 }),JSON.stringify({ ...data,extra:true }),JSON.stringify({ ...data,data:{ content:" ",visibility:"public",attachments:[] } })]) {
      f.values.set(key,raw); const before = f.mutations(); await expect(f.port().reviewInvalid()).rejects.toThrow(); expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before);
    }
    f.values.delete(key); const c = await f.open(); c.setDraft("添付の期限を確認する本文"); await c.addFiles([new File([new Uint8Array([137,80,78,71])],"期限付き.png",{type:"image/png"})]); await c.flushRecovery(); c.dispose();
    const saved = JSON.parse(f.values.get(key)!); saved.data.attachments[0].upload.expiresAt = new Date(Date.now()-1000).toISOString(); const expired = JSON.stringify(saved); f.values.set(key,expired); const before = f.mutations();
    await expect(f.port().reviewInvalid()).rejects.toMatchObject({ code:"changed" }); expect(f.values.get(key)).toBe(expired); expect(f.mutations()).toBe(before);
    const next = await f.open(); expect(next.getState()).toMatchObject({ canSubmit:false,attachments:[{phase:"reselect"}],recovery:{ready:true,canReviewInvalid:false} }); expect(f.uploads()).toBe(1);
  } finally { await f.close(); }
});

test("scope input mutation cannot turn a healthy original saved draft into eligible corruption", async () => {
  const f = fixture();
  try {
    const mutable = { ...f.scope }, port = createFeedRecoveryStore({ store:f.store,scope:mutable }); await port.save(f.data()); const before = [...f.values];
    mutable.actorApId = f.session.hostUrl+"/users/other"; mutable.apiBaseUrl = f.session.hostUrl+"/different/api"; mutable.replyParentApId = f.target.apId;
    expect(await port.load()).toEqual(f.data()); await expect(port.reviewInvalid()).rejects.toMatchObject({ code:"changed" }); expect([...f.values]).toEqual(before);
  } finally { await f.close(); }
});

test("a storage-read failure and an absent canonical reader never grant corrupt-record discard", async () => {
  const f = fixture();
  try {
    const key = await f.seed(), raw = f.values.get(key); f.failGet(true); const c = await f.open(); expect(c.getState().recovery?.canReviewInvalid).toBe(false);
    f.failGet(false); await c.flushRecovery(); expect(c.getState().recovery?.canReviewInvalid).toBe(true);
    const legacy = await f.open(undefined,false); await legacy.reviewInvalidRecovery(); await legacy.discardInvalidRecovery(); expect(legacy.getState().recovery?.canReviewInvalid).toBe(false);
    expect(f.values.get(key)).toBe(raw); expect(f.bodies).toHaveLength(0);
  } finally { await f.close(); }
});

for (const action of ["cancel","pause","session","dispose"] as const) test(`late storage review cannot restore confirmation after ${action}`, async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try {
    const key = await f.seed(), raw = f.values.get(key), before = f.mutations(), c = await f.open();
    f.holdGet(entered.resolve,release.promise); const reviewing = c.reviewInvalidRecovery(); await entered.promise;
    if (action==="cancel") c.cancelInvalidRecoveryReview(); else if (action==="pause") c.pause(); else if (action==="session") c.updateSession({ ...f.session,accessToken:"synthetic-new-incarnation" }); else c.dispose();
    release.resolve(); await reviewing; await c.discardInvalidRecovery(); expect(c.getState().recovery?.invalidReview).toBe(false); expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before); expect(f.bodies).toHaveLength(0);
  } finally { release.resolve(); await f.close(); }
});

for (const stage of ["review","discard","read"] as const) test(`synchronous retirement while publishing ${stage} prevents the following storage or canonical dispatch`, async () => {
  const f = fixture(); let c: Awaited<ReturnType<typeof f.open>> | undefined, armed = false, atPause = 0;
  try {
    const key = await f.seed(), raw = f.values.get(key), before = f.mutations();
    c = await f.open(() => { const state=c?.getState().recovery; if(armed && (stage==="review"?state?.reviewingInvalid:stage==="discard"?state?.discardingInvalid:state?.discardPending&&state.checkingOutcome)){armed=false;atPause=f.reads();c?.pause();} });
    if (stage!=="review") await c.reviewInvalidRecovery(); armed=true;
    if(stage==="review") await c.reviewInvalidRecovery(); else await c.discardInvalidRecovery();
    expect(f.reads()).toBe(atPause); expect(f.outcomes()).toBe(0); expect(f.bodies).toHaveLength(0);
    if(stage!=="read"){expect(f.values.get(key)).toBe(raw);expect(f.mutations()).toBe(before);}
  } finally { await f.close(); }
});

test("the actual notification caller publishes canonical replies and recovers the same reply composer", async () => {
  const f=fixture(true);let owner:ReturnType<typeof createNotificationController>|undefined;
  try {
    await f.seed(); owner=createNotificationController({session:f.session,getActorId:()=>f.scope.actorApId,replyRecovery:()=>f.port()});await owner.openPost(f.target.apId);const c=owner.getReplyComposer()!;await c.restoreRecovery();
    await c.reviewInvalidRecovery();await c.discardInvalidRecovery();expect(owner.getState().repliesLoaded).toBe(true);expect(c.getState().recovery?.ready).toBe(true);expect(f.bodies).toHaveLength(0);
    c.setDraft("正規callerから復帰した返信");await c.submit();expect(f.bodies).toHaveLength(1);expect(f.bodies[0].in_reply_to).toBe(f.target.apId);
  }finally{owner?.dispose();await f.close();}
});

test("canonical saved-row namespaces and retirement isolate feed/reply/actor/API/view and fresh rows", async () => {
  const f=fixture();
  try{
    const accounts=createFeedRecoveryAccounts({store:f.store}),row={id:"corrupt_composer_row_A_001",product:"yurucommu" as const,hostUrl:f.session.hostUrl,lastUsedAt:f.session.createdAt},fresh={...row,id:"corrupt_composer_row_B_002"};
    const old=accounts.bind(row,f.scope);await old.save(f.data());
    const [envelopeKey,envelopeRaw]=[...f.values].find(([,raw])=>Object.hasOwn(JSON.parse(raw),"entries"))!,envelope=JSON.parse(envelopeRaw),key=envelope.entries[0][0];
    const corrupt=()=>{const data=JSON.parse(f.values.get(envelopeKey)!),tuple=data.entries.find(([k]:[string,string])=>k===key),value=JSON.parse(tuple[1]);value.data.content=123;tuple[1]=JSON.stringify(value);f.values.set(envelopeKey,JSON.stringify(data));};corrupt();
    const others=[accounts.bind(row,{...f.scope,actorApId:f.session.hostUrl+"/users/other"}),accounts.bind(row,{...f.scope,apiBaseUrl:f.session.hostUrl+"/alternate/api"}),accounts.bind(fresh,f.scope)];for(const other of others)await other.save({...f.data(),content:"兄弟scopeの本文"});
    const replies=[accounts.bind(row,{...f.scope,replyParentApId:f.target.apId,replyView:"post"}),accounts.bind(row,{...f.scope,replyParentApId:f.target.apId,replyView:"profile"})];for(const other of replies)await other.save({...f.data(),reply:{target:f.target,audienceConfirmed:true}});
    await(await old.reviewInvalid()).discard();expect(await old.load()).toBe(null);for(const other of others)expect((await other.load())?.content).toBe("兄弟scopeの本文");for(const other of replies)expect((await other.load())?.reply?.target.apId).toBe(f.target.apId);
    await old.save(f.data());corrupt();const stale=await old.reviewInvalid();await accounts.retire(row);const after=[...f.values];await expect(stale.discard()).rejects.toThrow();expect([...f.values]).toEqual(after);expect((await others.at(-1)!.load())?.content).toBe("兄弟scopeの本文");
  }finally{await f.close();}
});
