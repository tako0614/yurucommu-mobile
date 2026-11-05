import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { postContentRevision, postWarning } from "../src/post-text.ts";
import { loadYurucommuMobileBookmarksPage } from "../src/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const post = {
  ap_id: "https://warning.fixture.test/ap/posts/one",
  content: "Hidden body",
  summary: "Warning",
  edited_at: null,
  attachments: [{ r2_key: "uploads/one.png", url: "/media/one.png", content_type: "image/png" }],
};

test("warnings distinguish absent, empty, meaningful and malformed metadata", () => {
  for (const absent of [undefined, null, ""]) expect(postWarning(absent)).toBeNull();
  expect(postWarning("  Warning\n")).toBe("Warning");
  for (const unknown of ["  ", false, 1, {}, []]) expect(postWarning(unknown)).toBe("内容の警告");
});

test("viewer counters and fresh object copies retain the same content revision", () => {
  const copy = { ...post, attachments: post.attachments.map(value => ({ ...value })), liked: true, like_count: 42 };
  expect(postContentRevision(copy)).toBe(postContentRevision(post));
});

test("changing any disclosed content or post identity requires a new decision", () => {
  for (const change of [
    { ap_id: post.ap_id + "-other" }, { content: "Different body" },
    { summary: "Different warning" }, { summary: null },
    { edited_at: "2026-11-05T01:00:00Z" },
    { attachments: [{ ...post.attachments[0], url: "/media/two.png" }] },
  ]) expect(postContentRevision({ ...post, ...change })).not.toBe(postContentRevision(post));
});

test("the real bookmarks reader preserves raw warning and body metadata", async () => {
  const host = "https://warning.fixture.test";
  const session: MobileSession = { hostUrl: host, product: "yurucommu", accessToken: "synthetic-warning-only", tokenType: "Bearer", createdAt: "2026-11-05T01:00:00Z" };
  const warnings: Array<string | null | undefined> = ["Warning", "", null, undefined];
  const rows = warnings.map((summary, i) => ({ ...post, ap_id: post.ap_id + i, summary, published: null, like_count: 0, reply_count: 0, author: { ap_id: host + "/ap/users/owner", preferred_username: "owner", name: null, icon_url: null } }));
  let requests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(host + "/api/bookmarks?limit=8");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-warning-only");
    requests++;
    return Response.json({ posts: rows });
  }) as typeof fetch;
  const loaded = await loadYurucommuMobileBookmarksPage(session);
  expect(loaded.map(value => value.summary)).toEqual(warnings);
  expect(loaded.map(value => value.content)).toEqual(rows.map(value => value.content));
  expect(loaded.map(value => value.attachments)).toEqual(rows.map(value => value.attachments));
  expect(requests).toBe(1);
});
