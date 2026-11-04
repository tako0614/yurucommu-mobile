import { expect, test } from "bun:test";
import { createProfileController } from "../src/profile-controller.ts";
const session = {
  product: "yurucommu" as const,
  hostUrl: "https://edit.fixture.test",
  accessToken: "synthetic-edit",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};

import { afterEach } from "bun:test";
import {
  loadMobileEditableProfile,
  saveMobileProfile,
  normalizeProfilePatch,
  profileForm,
} from "../src/profile-edit-api.ts";
import { createProfileEditController } from "../src/profile-edit-controller.ts";
const id = session.hostUrl + "/ap/users/owner",
  originalFetch = globalThis.fetch;
const actor = (extra: Record<string, unknown> = {}) => ({
  ap_id: id,
  preferred_username: "owner",
  username: "owner@edit.fixture.test",
  name: "Name",
  summary: null,
  icon_url: null,
  header_url: null,
  is_private: 0,
  fields: [],
  follower_count: 0,
  following_count: 0,
  post_count: 0,
  ...extra,
});
const me = (ap_id = id) => Response.json({ actor: { ap_id } });
const saved = (extra: Record<string, unknown> = {}) =>
  Response.json({ actor: actor(extra) });
type Call = { url: string; init?: RequestInit; resolve: (v: Response) => void };
const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  await Bun.sleep(0);
  globalThis.fetch = originalFetch;
});
function fixture() {
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) =>
      calls.push({ url: String(input), init, resolve }),
    )) as typeof fetch;
  cleanup.push(() => {
    for (const c of calls)
      c.resolve(Response.json({ error: "closed" }, { status: 503 }));
  });
  return calls;
}
async function until(check: () => boolean) {
  const end = Date.now() + 1000;
  while (!check() && Date.now() < end) await Bun.sleep(1);
  expect(check()).toBe(true);
}
async function read(
  calls: Call[],
  start = 0,
  extra: Record<string, unknown> = {},
) {
  calls[start]!.resolve(me());
  await until(() => calls.length === start + 2);
  calls[start + 1]!.resolve(saved(extra));
}
async function write(
  calls: Call[],
  start: number,
  extra: Record<string, unknown>,
) {
  calls[start]!.resolve(me());
  await until(() => calls.length === start + 2);
  calls[start + 1]!.resolve(Response.json({ success: true }));
  await until(() => calls.length === start + 3);
  calls[start + 2]!.resolve(saved(extra));
  await until(() => calls.length === start + 4);
  calls[start + 3]!.resolve(me());
}
async function ready(
  calls: Call[],
  options: Partial<Parameters<typeof createProfileEditController>[0]> = {},
) {
  const c = createProfileEditController({ session, ...options });
  cleanup.push(c.dispose);
  const opened = c.show(id);
  await read(calls);
  await opened;
  return c;
}

test("editor loads a complete actual self profile through selected server", async () => {
  const calls = fixture(),
    result = loadMobileEditableProfile(session, id);
  await read(calls);
  const value = await result;
  expect(profileForm(value)).toEqual({
    name: "Name",
    summary: "",
    icon_url: "",
    header_url: "",
    is_private: false,
    fields: [],
  });
  expect(calls[1]!.url).toBe(
    session.hostUrl + "/api/actors/" + encodeURIComponent(id),
  );
  for (const call of calls)
    expect(call.init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
});
for (const field of [
  "name",
  "summary",
  "icon_url",
  "header_url",
  "is_private",
  "fields",
])
  test(`missing editable ${field} never becomes an empty overwrite`, async () => {
    const calls = fixture(),
      result = loadMobileEditableProfile(session, id);
    calls[0]!.resolve(me());
    await until(() => calls.length === 2);
    const raw = actor();
    delete raw[field as keyof typeof raw];
    calls[1]!.resolve(Response.json({ actor: raw }));
    await expect(result).rejects.toThrow();
  });
test("viewer mismatch prevents any PUT even for a valid target", async () => {
  const calls = fixture(),
    result = saveMobileProfile(session, id, { name: "New" });
  calls[0]!.resolve(me(session.hostUrl + "/ap/users/other"));
  await expect(result).rejects.toThrow("本人");
  expect(calls).toHaveLength(1);
});
for (const patch of [
  { name: "x".repeat(51) },
  { summary: "x".repeat(501) },
  { icon_url: "javascript:alert(1)" },
  { header_url: "https://user:secret@example.test/a" },
  { is_private: "false" },
  { fields: Array(5).fill({ name: "a", value: "b" }) },
  { fields: [{ name: "x".repeat(256), value: "a" }] },
  { unexpected: "overwrite" },
])
  test("invalid profile input sends zero requests", async () => {
    const calls = fixture();
    await expect(
      saveMobileProfile(session, id, patch as never),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
test("normalization matches existing Core trim/empty-row contract without truncation", () => {
  expect(
    normalizeProfilePatch({
      name: " Name ",
      summary: " ",
      icon_url: "/media/avatar.png",
      is_private: true,
      fields: [
        { name: " ", value: " " },
        { name: " X ", value: " Y " },
      ],
    }),
  ).toEqual({
    name: "Name",
    summary: "",
    icon_url: "/media/avatar.png",
    is_private: true,
    fields: [{ name: "X", value: "Y" }],
  });
});
test("a partial PUT confirms ACK, canonical fields and same viewer within one owner", async () => {
  const calls = fixture(),
    result = saveMobileProfile(session, id, { name: " New ", summary: " " });
  await write(calls, 0, { name: "New" });
  expect((await result).name).toBe("New");
  expect(calls.map((c) => c.init?.method)).toEqual([
    "GET",
    "PUT",
    "GET",
    "GET",
  ]);
  expect(calls[1]!.url).toBe(session.hostUrl + "/api/actors/me");
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
    name: "New",
    summary: "",
  });
  expect(new Set(calls.map((c) => c.init?.signal)).size).toBe(1);
});
for (const ack of [{ success: false }, {}])
  test("invalid ACK is not saved and never auto retries", async () => {
    const calls = fixture(),
      result = saveMobileProfile(session, id, { name: "New" });
    calls[0]!.resolve(me());
    await until(() => calls.length === 2);
    calls[1]!.resolve(Response.json(ack));
    await expect(result).rejects.toThrow("保存応答");
    expect(calls).toHaveLength(2);
  });
test("canonical mismatch exposes an unconfirmed result rather than saved", async () => {
  const calls = fixture(),
    result = saveMobileProfile(session, id, { name: "New" });
  calls[0]!.resolve(me());
  await until(() => calls.length === 2);
  calls[1]!.resolve(Response.json({ success: true }));
  await until(() => calls.length === 3);
  calls[2]!.resolve(saved({ name: "Other writer" }));
  await expect(result).rejects.toThrow("一致");
  expect(calls).toHaveLength(3);
});
test("the final viewer identity must still match", async () => {
  const calls = fixture(),
    result = saveMobileProfile(session, id, { name: "New" });
  calls[0]!.resolve(me());
  await until(() => calls.length === 2);
  calls[1]!.resolve(Response.json({ success: true }));
  await until(() => calls.length === 3);
  calls[2]!.resolve(saved({ name: "New" }));
  await until(() => calls.length === 4);
  calls[3]!.resolve(me("https://other.example/person"));
  await expect(result).rejects.toThrow("本人");
});
test("saved partial fields do not clear newer in-flight edits or unsubmitted fields", async () => {
  const calls = fixture();
  let refreshed = 0;
  const c = await ready(calls, {
    onSaved: async () => {
      refreshed++;
    },
  });
  c.setField("name", " Submitted ");
  const saving = c.save();
  c.setField("name", "New draft");
  c.setField("summary", "Next bio");
  await write(calls, 2, { name: "Submitted" });
  expect(await saving).toBe(true);
  expect(c.getState()).toMatchObject({
    saving: false,
    uncertain: false,
    dirty: true,
    draft: { name: "New draft", summary: "Next bio" },
    canSave: true,
  });
  expect(c.getState().message).toContain("新しい変更");
  expect(JSON.parse(String(calls[3]!.init?.body))).toEqual({
    name: "Submitted",
  });
  expect(refreshed).toBe(1);
});
test("lost ACK requires read-only recovery and retains an unsaved newer draft", async () => {
  const calls = fixture(),
    c = await ready(calls);
  c.setField("name", "Submitted");
  const saving = c.save();
  calls[2]!.resolve(me());
  await until(() => calls.length === 4);
  c.setField("name", "Newer");
  calls[3]!.resolve(Response.json({ error: "lost ACK" }, { status: 503 }));
  await saving;
  expect(c.getState()).toMatchObject({
    uncertain: true,
    needsReload: true,
    canSave: false,
  });
  await c.save();
  expect(calls).toHaveLength(4);
  const recover = c.reload();
  await read(calls, 4, { name: "Submitted" });
  await recover;
  expect(c.getState()).toMatchObject({
    uncertain: false,
    draft: { name: "Newer" },
    dirty: true,
    canSave: true,
  });
  expect(calls.filter((c) => c.init?.method === "PUT")).toHaveLength(1);
});
test("recovered saved input adopts canonical trimming without a second PUT", async () => {
  const calls = fixture(),
    c = await ready(calls);
  c.setField("name", " Saved ");
  const saving = c.save();
  calls[2]!.resolve(me());
  await until(() => calls.length === 4);
  calls[3]!.resolve(Response.json({}, { status: 503 }));
  await saving;
  const recover = c.reload();
  await read(calls, 4, { name: "Saved" });
  await recover;
  expect(c.getState()).toMatchObject({
    draft: { name: "Saved" },
    dirty: false,
    canSave: false,
  });
  expect(calls.filter((c) => c.init?.method === "PUT")).toHaveLength(1);
});
test("close/reopen preserves unknown result and the retired action returns no focus intent", async () => {
  const calls = fixture(),
    c = await ready(calls);
  c.setField("name", "Sent");
  const saving = c.save();
  calls[2]!.resolve(me());
  await until(() => calls.length === 4);
  c.close();
  expect(calls[3]!.init?.signal?.aborted).toBe(true);
  await c.show(id);
  expect(calls).toHaveLength(4);
  calls[3]!.resolve(Response.json({ success: true }));
  expect(await saving).toBe(false);
  expect(c.getState()).toMatchObject({
    needsReload: true,
    uncertain: true,
    draft: { name: "Sent" },
  });
});
test("a retired receipt cannot refresh home", async () => {
  const calls = fixture();
  let retire = false,
    refreshed = 0;
  const c = await ready(calls, {
    onReceipt: () => {
      if (retire) c.close();
    },
    onSaved: async () => {
      refreshed++;
    },
  });
  retire = true;
  c.setField("name", "New");
  const saving = c.save();
  await write(calls, 2, { name: "New" });
  expect(await saving).toBe(false);
  expect(refreshed).toBe(0);
});
test("home refresh failure stays separate from confirmed profile save", async () => {
  const calls = fixture(),
    c = await ready(calls, {
      onSaved: async () => {
        throw Error("offline");
      },
    });
  c.setField("summary", "Bio");
  const saving = c.save();
  await write(calls, 2, { summary: "Bio" });
  await saving;
  expect(c.getState()).toMatchObject({
    uncertain: false,
    dirty: false,
    needsReload: false,
  });
  expect(c.getState().refreshError).toContain("ホーム");
});
test("image selection reuses validated multipart upload and preserves the canonical media path", async () => {
  const calls = fixture(),
    c = await ready(calls);
  const uploading = c.pickImage(
    "icon_url",
    new File([new Uint8Array([1, 2, 3])], "写真.png", { type: "image/png" }),
  );
  await until(() => calls.length === 3);
  expect(calls[2]!.url).toBe(session.hostUrl + "/api/media/upload");
  expect(calls[2]!.init?.body).toBeInstanceOf(FormData);
  calls[2]!.resolve(
    Response.json({
      r2_key: "uploads/aabb.png",
      url: "/media/aabb.png",
      content_type: "image/png",
    }),
  );
  await uploading;
  expect(c.getState()).toMatchObject({
    draft: { icon_url: "/media/aabb.png" },
    uploads: { icon_url: { name: "写真.png", phase: "ready" } },
    canSave: true,
  });
  c.restoreImage("icon_url");
  expect(c.getState()).toMatchObject({
    draft: { icon_url: "" },
    canSave: false,
  });
});
test("a failed image choice blocks accidental save until explicit retry or cancellation", async () => {
  const calls = fixture(),
    c = await ready(calls);
  c.setField("name", "New");
  await c.pickImage(
    "header_url",
    new File(["x"], "bad.svg", { type: "image/svg+xml" }),
  );
  expect(calls).toHaveLength(2);
  expect(c.getState().canSave).toBe(false);
  expect(c.getState().uploads.header_url?.phase).toBe("error");
  c.restoreImage("header_url");
  expect(c.getState().canSave).toBe(true);
});
test("manual image replacement aborts a pending upload and fences its late response", async () => {
  const calls = fixture(),
    c = await ready(calls);
  const uploading = c.pickImage(
    "icon_url",
    new File(["x"], "pic.png", { type: "image/png" }),
  );
  await until(() => calls.length === 3);
  c.setField("icon_url", "https://images.example/new.png");
  expect(calls[2]!.init?.signal?.aborted).toBe(true);
  calls[2]!.resolve(
    Response.json({
      r2_key: "uploads/aabb.png",
      url: "/media/aabb.png",
      content_type: "image/png",
    }),
  );
  expect(await uploading).toBe(false);
  expect(c.getState().draft.icon_url).toBe("https://images.example/new.png");
});
test("explicit discard cannot erase an edit made while confirmation is pending", async () => {
  const calls = fixture();
  let decide: ((v: boolean) => void) | undefined;
  const c = await ready(calls, {
    confirmDiscard: () =>
      new Promise<boolean>((resolve) => {
        decide = resolve;
      }),
  });
  c.setField("summary", "Old draft");
  const discarding = c.discard();
  c.setField("summary", "New draft");
  decide!(true);
  expect(await discarding).toBe(false);
  expect(c.getState().draft.summary).toBe("New draft");
  expect(calls).toHaveLength(2);
});

test("expired uncommitted image requires reupload without resubmitting the profile", async () => {
  const calls = fixture(),
    c = await ready(calls);
  const uploading = c.pickImage(
    "header_url",
    new File(["x"], "pic.png", { type: "image/png" }),
  );
  await until(() => calls.length === 3);
  calls[2]!.resolve(
    Response.json({
      r2_key: "uploads/aabb.png",
      url: "/media/aabb.png",
      content_type: "image/png",
      expires_at: new Date(Date.now() + 150).toISOString(),
    }),
  );
  await uploading;
  await Bun.sleep(180);
  expect(c.getState().canSave).toBe(false);
  expect(c.getState().validation).toContain("有効期限");
  await c.save();
  expect(calls.filter((c) => c.init?.method === "PUT")).toHaveLength(0);
});
test("replacing the selected account retires its editor and ignores late ACK", async () => {
  const calls = fixture(),
    p = createProfileController({ session });
  cleanup.push(p.dispose);
  const opened = p.open(id);
  calls[0]!.resolve(saved());
  await until(() => calls.length === 2);
  calls[1]!.resolve(
    Response.json({ posts: [], has_more: false, next_cursor: null }),
  );
  await opened;
  const c = p.getEditor(),
    shown = c.show(id);
  await read(calls, 2);
  await shown;
  c.setField("summary", "Old account draft");
  const saving = c.save();
  calls[4]!.resolve(me());
  await until(() => calls.length === 6);
  p.updateSession({ ...session, accessToken: "another-synthetic-account" });
  expect(calls[5]!.init?.signal?.aborted).toBe(true);
  expect(p.getEditor()).not.toBe(c);
  calls[5]!.resolve(Response.json({ success: true }));
  expect(await saving).toBe(false);
  expect(p.getState().actor).toBeNull();
  expect(p.getEditor().getState().loaded).toBe(false);
});
test("closing a profile aborts image upload and preserves its draft for the same account", async () => {
  const calls = fixture(),
    p = createProfileController({ session });
  cleanup.push(p.dispose);
  const opened = p.open(id);
  calls[0]!.resolve(saved());
  await until(() => calls.length === 2);
  calls[1]!.resolve(
    Response.json({ posts: [], has_more: false, next_cursor: null }),
  );
  await opened;
  const c = p.getEditor(),
    shown = c.show(id);
  await read(calls, 2);
  await shown;
  c.setField("summary", "Draft retained");
  const uploading = c.pickImage(
    "icon_url",
    new File(["x"], "pic.png", { type: "image/png" }),
  );
  await until(() => calls.length === 5);
  p.close();
  expect(calls[4]!.init?.signal?.aborted).toBe(true);
  calls[4]!.resolve(
    Response.json({
      r2_key: "uploads/aabb.png",
      url: "/media/aabb.png",
      content_type: "image/png",
    }),
  );
  expect(await uploading).toBe(false);
  expect(c.getState()).toMatchObject({
    visible: false,
    draft: { summary: "Draft retained", icon_url: "" },
  });
});
test("actual HTTP profile ACK body stays inside the unchanged 15s owner budget", async () => {
  let writes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(req) {
      if (req.method === "PUT") {
        writes++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"success":'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return me();
    },
  });
  const start = Date.now();
  try {
    await expect(
      saveMobileProfile({ ...session, hostUrl: server.url.origin }, id, {
        name: "New",
      }),
    ).rejects.toThrow();
    expect(writes).toBe(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(14500);
    expect(Date.now() - start).toBeLessThan(19000);
  } finally {
    server.stop(true);
  }
}, 20000);

test("confirmed image association is reported saved while later text remains dirty", async () => {
  const calls = fixture(),
    c = await ready(calls);
  const uploading = c.pickImage(
    "icon_url",
    new File(["x"], "pic.png", { type: "image/png" }),
  );
  await until(() => calls.length === 3);
  calls[2]!.resolve(
    Response.json({
      r2_key: "uploads/aabb.png",
      url: "/media/aabb.png",
      content_type: "image/png",
    }),
  );
  await uploading;
  const saving = c.save();
  await write(calls, 3, { icon_url: "/media/aabb.png" });
  await saving;
  c.setField("summary", "Later text");
  expect(c.getState().uploads.icon_url?.saved).toBe(true);
  expect(c.getState().dirty).toBe(true);
});

for (const nextName of ["New during reload", "Name"])
  test("confirmed discard preserves fields touched while its GET is pending", async () => {
    const calls = fixture(),
      c = await ready(calls, { confirmDiscard: () => true });
    c.setField("name", "Old discarded name");
    c.setField("summary", "Old discarded summary");
    const discarding = c.discard();
    await until(() => calls.length === 3);
    c.setField("name", nextName);
    c.setField("is_private", true);
    c.setField("fields", [{ name: "New field", value: "New value" }]);
    await read(calls, 2, { name: "Server name", summary: "Server bio" });
    expect(await discarding).toBe(true);
    expect(c.getState().draft).toMatchObject({
      name: nextName,
      summary: "Server bio",
      is_private: true,
      fields: [{ name: "New field", value: "New value" }],
    });
    expect(c.getState().dirty).toBe(true);
  });
