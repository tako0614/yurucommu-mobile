import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import {
  loadMobileProfileFollow,
  setMobileProfileFollow,
} from "../src/profile-follow-api.ts";
import { createProfileFollowController } from "../src/profile-follow-controller.ts";
import { createProfileController } from "../src/profile-controller.ts";
const session: MobileSession = {
  product: "yurucommu",
  hostUrl: "https://follow.fixture.test",
  accessToken: "synthetic-follow",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
const id = "https://remote.example/users/author?x=1&y=2";
const me = session.hostUrl + "/users/viewer";
const actor = (extra: Record<string, unknown> = {}) => ({
  ap_id: id,
  preferred_username: "author",
  username: "author@remote.example",
  name: "Author",
  summary: "profile",
  icon_url: null,
  fields: [],
  follower_count: 3,
  following_count: 5,
  post_count: 2,
  ...extra,
});
const profile = (
  status: string | null = "none",
  extra: Record<string, unknown> = {},
) =>
  Response.json({
    actor: actor({
      ...(status === null ? {} : { outgoing_follow_status: status }),
      is_following: status === "accepted",
      ...extra,
    }),
  });
const viewer = (extra: Record<string, unknown> = {}) =>
  Response.json({ actor: { ap_id: me, following_count: 4, ...extra } });
type Call = {
  url: string;
  init?: RequestInit;
  resolve: (value: Response) => void;
};
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await Bun.sleep(0);
  globalThis.fetch = originalFetch;
});
function fixture() {
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({ url: String(input), init, resolve });
    })) as typeof fetch;
  cleanups.push(() => {
    for (const call of calls)
      call.resolve(Response.json({ error: "fixture closed" }, { status: 503 }));
  });
  return calls;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check() && Date.now() < deadline) await Bun.sleep(1);
  expect(check()).toBe(true);
}
async function resolveRead(
  calls: Call[],
  status: string | null = "none",
  start = 0,
  fields: Record<string, unknown> = {},
) {
  calls[start]!.resolve(viewer());
  await until(() => calls.length === start + 2);
  calls[start + 1]!.resolve(profile(status, fields));
}
function controller(
  calls: Call[],
  options: Partial<Parameters<typeof createProfileFollowController>[0]> = {},
) {
  const c = createProfileFollowController({ session, actorId: id, ...options });
  cleanups.push(c.dispose);
  c.setActive(true);
  return c;
}
async function ready(
  calls: Call[],
  status = "none",
  options: Partial<Parameters<typeof createProfileFollowController>[0]> = {},
) {
  const c = controller(calls, options);
  await resolveRead(calls, status);
  await until(() => !c.getState().busy);
  return c;
}
async function resolveWrite(
  calls: Call[],
  status: string,
  start: number,
  ackStatus = status,
) {
  calls[start]!.resolve(viewer());
  await until(() => calls.length === start + 2);
  calls[start + 1]!.resolve(
    Response.json({
      success: true,
      ...(status === "none" ? {} : { status: ackStatus }),
    }),
  );
  await until(() => calls.length === start + 3);
  calls[start + 2]!.resolve(
    profile(status, { follower_count: status === "accepted" ? 4 : 3 }),
  );
  await until(() => calls.length === start + 4);
  calls[start + 3]!.resolve(
    viewer({ following_count: status === "accepted" ? 5 : 4 }),
  );
}
for (const status of ["none", "pending", "accepted", null])
  test(`raw outgoing state ${status} is preserved`, async () => {
    const calls = fixture(),
      result = loadMobileProfileFollow(session, id);
    await resolveRead(calls, status);
    expect(await result).toMatchObject({
      status,
      isSelf: false,
      viewerId: me,
      viewerFollowing: 4,
    });
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([
      session.hostUrl,
      session.hostUrl,
    ]);
    expect(calls[1]!.url).toBe(
      session.hostUrl + "/api/actors/" + encodeURIComponent(id),
    );
    for (const c of calls)
      expect(c.init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      });
  });
for (const fields of [
  { outgoing_follow_status: "rejected" },
  { outgoing_follow_status: "accepted", is_following: false },
  { outgoing_follow_status: "pending", is_following: true },
  { is_following: undefined },
  { ap_id: "https://wrong.example/users/author" },
  { follower_count: -1 },
])
  test("malformed or contradictory selected-server state is rejected", async () => {
    const calls = fixture(),
      result = loadMobileProfileFollow(session, id);
    await resolveRead(calls, "none", 0, fields);
    await expect(result).rejects.toThrow();
  });
test("missing raw relationship state cannot turn a normalized false flag into write authority", async () => {
  const calls = fixture(),
    c = controller(calls);
  await resolveRead(calls, null);
  await until(() => !c.getState().busy);
  expect(c.getState()).toMatchObject({
    status: null,
    needsReload: true,
    canChange: false,
  });
  await c.change();
  expect(calls).toHaveLength(2);
});
test("self identity is read from auth/me and rejects a mutation before POST", async () => {
  const calls = fixture(),
    result = setMobileProfileFollow(session, id, true);
  calls[0]!.resolve(viewer({ ap_id: id }));
  await expect(result).rejects.toThrow("自分自身");
  expect(calls).toHaveLength(1);
});
for (const target of [true, false])
  test(`follow ${target} requires actual ACK, canonical persisted state and same-viewer readback`, async () => {
    const calls = fixture(),
      result = setMobileProfileFollow(session, id, target);
    await resolveWrite(calls, target ? "accepted" : "none", 0);
    expect(await result).toMatchObject({
      status: target ? "accepted" : "none",
      viewerId: me,
      viewerFollowing: target ? 5 : 4,
    });
    expect(calls.map((c) => c.init?.method)).toEqual([
      "GET",
      target ? "POST" : "DELETE",
      "GET",
      "GET",
    ]);
    expect(calls[1]!.url).toBe(session.hostUrl + "/api/follow");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      target_ap_id: id,
    });
    expect(new Set(calls.map((c) => c.init?.signal)).size).toBe(1);
  });
test("pending ACK can advance legitimately to accepted before canonical readback", async () => {
  const calls = fixture(),
    result = setMobileProfileFollow(session, id, true);
  await resolveWrite(calls, "accepted", 0, "pending");
  expect((await result).status).toBe("accepted");
});
for (const response of [
  Response.json({ success: true }),
  Response.json({ success: false, status: "accepted" }),
  Response.json({ success: true, status: "none" }),
  Response.json({ error: "denied" }, { status: 403 }),
])
  test("invalid ACK or denied write never pretends to confirm or retries", async () => {
    const calls = fixture(),
      result = setMobileProfileFollow(session, id, true);
    calls[0]!.resolve(viewer());
    await until(() => calls.length === 2);
    calls[1]!.resolve(response);
    await expect(result).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
for (const target of [true, false])
  test("contradictory readback remains an unknown write outcome", async () => {
    const calls = fixture(),
      result = setMobileProfileFollow(session, id, target);
    calls[0]!.resolve(viewer());
    await until(() => calls.length === 2);
    calls[1]!.resolve(Response.json({ success: true, status: "accepted" }));
    await until(() => calls.length === 3);
    calls[2]!.resolve(profile(target ? "pending" : "accepted"));
    await expect(result).rejects.toThrow("一致");
    expect(calls).toHaveLength(3);
  });
test("a changed viewer during a write cannot confirm another account's result", async () => {
  const calls = fixture(),
    result = setMobileProfileFollow(session, id, true);
  calls[0]!.resolve(viewer());
  await until(() => calls.length === 2);
  calls[1]!.resolve(Response.json({ success: true, status: "accepted" }));
  await until(() => calls.length === 3);
  calls[2]!.resolve(profile("accepted"));
  await until(() => calls.length === 4);
  calls[3]!.resolve(viewer({ ap_id: session.hostUrl + "/users/other" }));
  await expect(result).rejects.toThrow("本人");
});
for (const count of [-1, 1.5, "5"])
  test("invalid viewer counts fail before a write", async () => {
    const calls = fixture(),
      result = setMobileProfileFollow(session, id, true);
    calls[0]!.resolve(viewer({ following_count: count }));
    await expect(result).rejects.toThrow("件数");
    expect(calls).toHaveLength(1);
  });
for (const initial of ["none", "pending", "accepted"])
  test(`controller ${initial} offers the correct operation and refreshes home only on confirmation`, async () => {
    const calls = fixture();
    let refreshed = 0;
    const c = await ready(calls, initial, {
      onConfirmed: async () => {
        refreshed++;
      },
    });
    expect(refreshed).toBe(0);
    expect(c.getState().canChange).toBe(true);
    const result = c.change();
    const next = initial === "none" ? "pending" : "none";
    await resolveWrite(calls, next, 2);
    await result;
    expect(c.getState()).toMatchObject({
      status: next,
      busy: false,
      uncertain: false,
      needsReload: false,
    });
    expect(calls[3]!.init?.method).toBe(initial === "none" ? "POST" : "DELETE");
    expect(refreshed).toBe(1);
    if (initial === "pending")
      expect(c.getState().message).toContain("申請を取り消し");
  });
test("unknown ACK blocks repeated writes and reactivation until an explicit state read", async () => {
  const calls = fixture();
  let refresh = 0;
  const c = await ready(calls, "none", {
    onConfirmed: async () => {
      refresh++;
    },
  });
  const result = c.change();
  calls[2]!.resolve(viewer());
  await until(() => calls.length === 4);
  calls[3]!.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
  await result;
  expect(c.getState()).toMatchObject({
    uncertain: true,
    needsReload: true,
    canChange: false,
  });
  await c.change();
  c.setActive(false);
  c.setActive(true);
  await Bun.sleep(1);
  expect(calls).toHaveLength(4);
  const read = c.reload();
  await resolveRead(calls, "accepted", 4);
  await read;
  expect(c.getState()).toMatchObject({
    status: "accepted",
    uncertain: false,
    canChange: true,
  });
  expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  expect(refresh).toBe(1);
});
test("pausing a pending operation aborts it and ignores its late body without callbacks", async () => {
  const calls = fixture();
  let receipts = 0,
    confirmed = 0;
  const c = await ready(calls, "none", {
    onReceipt: () => {
      receipts++;
    },
    onConfirmed: async () => {
      confirmed++;
    },
  });
  const result = c.change();
  calls[2]!.resolve(viewer());
  await until(() => calls.length === 4);
  c.setActive(false);
  expect(calls[3]!.init?.signal?.aborted).toBe(true);
  calls[3]!.resolve(Response.json({ success: true, status: "accepted" }));
  await result;
  expect(c.getState()).toMatchObject({
    uncertain: true,
    needsReload: true,
    busy: false,
  });
  expect(receipts).toBe(1);
  expect(confirmed).toBe(0);
  expect(calls).toHaveLength(4);
});
test("a receipt callback that retires this owner cannot trigger a home refresh", async () => {
  const calls = fixture();
  let confirmed = 0,
    retire = false;
  const c = await ready(calls, "none", {
    onReceipt: () => {
      if (retire) c.setActive(false);
    },
    onConfirmed: async () => {
      confirmed++;
    },
  });
  retire = true;
  const result = c.change();
  await resolveWrite(calls, "accepted", 2);
  await result;
  expect(confirmed).toBe(0);
  expect(c.getState().canChange).toBe(false);
});
test("confirmed relationship survives a failed optional home count refresh", async () => {
  const calls = fixture(),
    c = await ready(calls, "none", {
      onConfirmed: async () => {
        throw Error("home offline");
      },
    });
  const result = c.change();
  await resolveWrite(calls, "accepted", 2);
  await result;
  expect(c.getState()).toMatchObject({
    status: "accepted",
    needsReload: false,
    canChange: true,
  });
  expect(c.getState().refreshError).toContain("ホーム");
});
test("profile close aborts the owned follow request without relying on a screen render effect", async () => {
  const calls = fixture(),
    p = createProfileController({ session });
  cleanups.push(p.dispose);
  const opened = p.open(id);
  calls[0]!.resolve(profile());
  await until(() => calls.length === 2);
  calls[1]!.resolve(
    Response.json({ posts: [], has_more: false, next_cursor: null }),
  );
  await opened;
  p.setFollowActive(true);
  await resolveRead(calls, "none", 2);
  const f = p.getFollowController()!;
  await until(() => !f.getState().busy);
  const pending = f.change();
  calls[4]!.resolve(viewer());
  await until(() => calls.length === 6);
  p.close();
  expect(calls[5]!.init?.signal?.aborted).toBe(true);
  calls[5]!.resolve(Response.json({ success: true, status: "accepted" }));
  await pending;
  expect(f.getState()).toMatchObject({
    busy: false,
    needsReload: true,
    uncertain: true,
  });
});

test("a session replacement aborts the old profile relationship and retains no write authority", async () => {
  const calls = fixture(),
    p = createProfileController({ session });
  cleanups.push(p.dispose);
  const opened = p.open(id);
  calls[0]!.resolve(profile());
  await until(() => calls.length === 2);
  calls[1]!.resolve(
    Response.json({ posts: [], has_more: false, next_cursor: null }),
  );
  await opened;
  p.setFollowActive(true);
  await resolveRead(calls, "none", 2);
  const old = p.getFollowController()!;
  await until(() => !old.getState().busy);
  const write = old.change();
  calls[4]!.resolve(viewer());
  await until(() => calls.length === 6);
  p.updateSession({ ...session, accessToken: "different-synthetic-account" });
  expect(calls[5]!.init?.signal?.aborted).toBe(true);
  expect(p.getFollowController()).toBeUndefined();
  calls[5]!.resolve(Response.json({ success: true, status: "accepted" }));
  await write;
  expect(p.getState().actor).toBeNull();
  expect(old.getState().canChange).toBe(false);
});
test("switching targets preserves each unknown result until an explicit read", async () => {
  const calls = fixture(),
    p = createProfileController({ session });
  cleanups.push(p.dispose);
  async function open(target: string, start: number) {
    const pending = p.open(target);
    calls[start]!.resolve(profile("none", { ap_id: target }));
    await until(() => calls.length === start + 2);
    calls[start + 1]!.resolve(
      Response.json({ posts: [], has_more: false, next_cursor: null }),
    );
    await pending;
  }
  await open(id, 0);
  p.setFollowActive(true);
  await resolveRead(calls, "none", 2);
  const old = p.getFollowController()!;
  await until(() => !old.getState().busy);
  const write = old.change();
  calls[4]!.resolve(viewer());
  await until(() => calls.length === 6);
  const other = session.hostUrl + "/users/other";
  await open(other, 6);
  expect(calls[5]!.init?.signal?.aborted).toBe(true);
  calls[5]!.resolve(Response.json({ success: true, status: "accepted" }));
  await write;
  await open(id, 8);
  p.setFollowActive(true);
  await Bun.sleep(1);
  expect(p.getFollowController()).toBe(old);
  expect(old.getState()).toMatchObject({
    needsReload: true,
    uncertain: true,
    canChange: false,
  });
  expect(calls).toHaveLength(10);
});
test("actual HTTP mutation body remains inside the unchanged 15s owner deadline", async () => {
  let posts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(req) {
      if (req.method === "POST") {
        posts++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"success":true,'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return viewer();
    },
  });
  const started = Date.now();
  try {
    await expect(
      setMobileProfileFollow(
        { ...session, hostUrl: server.url.origin },
        id,
        true,
      ),
    ).rejects.toThrow();
    expect(posts).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(14500);
    expect(Date.now() - started).toBeLessThan(19000);
  } finally {
    server.stop(true);
  }
}, 20000);

for (const raw of [["none"], ["pending"], { state: "none" }])
  test("non-string raw authority state cannot enable a destructive follow action", async () => {
    const calls = fixture(),
      c = controller(calls);
    await resolveRead(calls, "none", 0, { outgoing_follow_status: raw });
    await until(() => !c.getState().busy);
    expect(c.getState().canChange).toBe(false);
    await c.change();
    expect(calls).toHaveLength(2);
  });

test("a retired same-actor action cannot request focus after close and reopen", async () => {
  const calls = fixture(),
    c = await ready(calls);
  const write = c.change();
  calls[2]!.resolve(viewer());
  await until(() => calls.length === 4);
  c.setActive(false);
  c.setActive(true);
  calls[3]!.resolve(Response.json({ success: true, status: "accepted" }));
  expect(await write).toBe(false);
  expect(c.getState()).toMatchObject({ needsReload: true, uncertain: true });
});

test("a reactive screen cannot rearm a relationship while profile close is retiring it", async () => {
  const calls = fixture();
  const p = createProfileController({
    session,
    onChange: () => {
      const state = p.getState();
      p.setFollowActive(state.visible && !state.loading && !state.error);
    },
  });
  cleanups.push(p.dispose);
  const opened = p.open(id);
  calls[0]!.resolve(profile());
  await until(() => calls.length === 3);
  calls[2]!.resolve(
    Response.json({ posts: [], has_more: false, next_cursor: null }),
  );
  calls[1]!.resolve(viewer());
  await until(() => calls.length === 4);
  calls[3]!.resolve(profile());
  await opened;
  const f = p.getFollowController()!;
  await until(() => !f.getState().busy);
  p.close();
  expect(calls).toHaveLength(4);
  expect(f.getState().needsReload).toBe(false);
  const reopen = p.open(id);
  await resolveRead(calls, "none", 4);
  await reopen;
  await until(() => !f.getState().busy);
  expect(f.getState().canChange).toBe(true);
});
