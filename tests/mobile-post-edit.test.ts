import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const base = "https://post-edit.fixture.test", owner = base + "/ap/users/owner", id = base + "/ap/posts/own";
const session: MobileSession = { hostUrl: base, product: "yurucommu", accessToken: "synthetic-edit-only", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" };
function fixture() {
    let content = "<p>Literal &amp; #tag</p>\n" + "x".repeat(600), summary: string | null = "Original warning";
    let me = owner, fail: Response | undefined, patchHold: Promise<void> | undefined;
    const calls: Array<{
        method: string;
        path: string;
        body?: unknown;
    }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(String(input)), method = init?.method ?? "GET";
        if (u.origin !== base)
            throw Error("External request refused");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-edit-only");
        calls.push({ method, path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (u.pathname === "/api/auth/me")
            return Response.json({ actor: { ap_id: me } });
        if (u.pathname === "/api/actors/" + encodeURIComponent(owner))
            return Response.json({ actor: { ap_id: owner, preferred_username: "owner", username: "owner", name: null, summary: null, icon_url: null, header_url: null, post_count: 1, follower_count: 0, following_count: 0, is_private: false, fields: [] } });
        if (u.pathname === "/api/actors/" + encodeURIComponent(owner) + "/posts")
            return Response.json({ posts: [], has_more: false, next_cursor: null });
        if (u.pathname !== "/api/posts/" + encodeURIComponent(id))
            throw Error("Unexpected request");
        if (method === "PATCH") {
            if (fail)
                return fail;
            const patch = JSON.parse(String(init?.body));
            if (patch.content !== undefined)
                content = patch.content;
            if (patch.summary !== undefined)
                summary = patch.summary || null;
            const ack = Response.json({ success: true, post: { ap_id: id, content, summary } });
            const hold = patchHold;
            patchHold = undefined;
            if (hold)
                await hold;
            return ack;
        }
        return Response.json({ post: { ap_id: id, type: "Note", author: { ap_id: owner, preferred_username: "owner", username: "owner", name: null, icon_url: null }, content, summary, attachments: [], in_reply_to: null, visibility: "public", community_ap_id: null, like_count: 0, reply_count: 0, announce_count: 0, published: "2026-11-05T00:00:00Z", liked: false, bookmarked: false, reposted: false, edited_at: null } });
    }) as typeof fetch;
    return { calls, content: () => content, summary: () => summary, changeContent: (value: string) => { content = value; }, changeSummary: (value: string | null) => { summary = value; }, changeViewer: (value: string) => { me = value; }, failPatch: (value: Response) => { fail = value; }, holdPatch: (value: Promise<void>) => { patchHold = value; } };
}
test("edit prefill uses the exact raw published content, including a web-sized body", async () => {
    const api = await import("../src/post-edit-api.ts"), f = fixture();
    const post = await api.loadMobileEditablePost(session, id, owner);
    expect(post.content).toBe(f.content());
    expect(post.content.length).toBeGreaterThan(500);
    expect(post.summary).toBe("Original warning");
    expect(f.calls.every(c => c.method === "GET")).toBe(true);
});
test("clearing a content warning sends only an empty string and confirms canonical state", async () => {
    const api = await import("../src/post-edit-api.ts"), f = fixture();
    const before = await api.loadMobileEditablePost(session, id, owner);
    const receipt = await api.saveMobilePostEdit(session, before, { summary: "" });
    expect(f.calls.filter(c => c.method === "PATCH").map(c => c.body)).toEqual([{ summary: "" }]);
    expect(receipt.summary).toBeNull();
    expect(receipt.content).toBe(before.content);
});
test("a field already changed by another writer is not overwritten", async () => {
    const api = await import("../src/post-edit-api.ts"), f = fixture();
    const before = await api.loadMobileEditablePost(session, id, owner);
    f.changeContent("Other writer");
    await expect(api.saveMobilePostEdit(session, before, { content: "My change" })).rejects.toMatchObject({ outcome: "not_applied" });
    expect(f.calls.filter(c => c.method === "PATCH")).toHaveLength(0);
    expect(f.content()).toBe("Other writer");
});
test("fresh identity mismatch prevents PATCH and a failed PATCH receipt remains unknown", async () => {
    const api = await import("../src/post-edit-api.ts"), f = fixture();
    const before = await api.loadMobileEditablePost(session, id, owner);
    f.changeViewer(base + "/ap/users/other");
    await expect(api.saveMobilePostEdit(session, before, { content: "My change" })).rejects.toMatchObject({ outcome: "not_applied" });
    expect(f.calls.filter(c => c.method === "PATCH")).toHaveLength(0);
    f.changeViewer(owner);
    f.failPatch(Response.json({ error: "Receipt unavailable" }, { status: 503 }));
    await expect(api.saveMobilePostEdit(session, before, { content: "My change" })).rejects.toMatchObject({ outcome: "unknown" });
    expect(f.calls.filter(c => c.method === "PATCH")).toHaveLength(1);
});
test("confirmed edits replace earlier reads while preserving the original like-read provenance", async () => {
    const api = await import("../src/post-edit-api.ts");
    const { createPostEditStore } = await import("../src/post-edit-store.ts");
    const { recordMobilePostLikeRead, mobilePostLikeReadStartedAt } = await import("../src/api.ts");
    const f = fixture(), store = createPostEditStore({ session });
    const before = await api.loadMobileEditablePost(session, id, owner);
    const old = recordMobilePostLikeRead({ ap_id: id, content: before.content, author: { ap_id: owner }, liked: true, like_count: 4 }, session, before.readStartedAt);
    const saved = await api.saveMobilePostEdit(session, before, { content: "Saved body" });
    expect(store.record(saved)).toBe(true);
    const shown = store.project(old);
    expect(shown.content).toBe("Saved body");
    expect(shown.liked).toBe(true);
    expect(shown.like_count).toBe(4);
    expect(mobilePostLikeReadStartedAt(shown, session)).toBe(before.readStartedAt);
    const newer = recordMobilePostLikeRead({ ...old, content: "Later legitimate writer" }, session, saved.readStartedAt + 1);
    expect(store.project(newer).content).toBe("Later legitimate writer");
    expect(JSON.stringify(saved)).not.toContain("synthetic-edit-only");
});
test("a retired connection cannot adopt an old edit receipt or use its baseline for a new write", async () => {
    const api = await import("../src/post-edit-api.ts"), { createPostEditStore } = await import("../src/post-edit-store.ts");
    const f = fixture(), store = createPostEditStore({ session });
    const post = await api.loadMobileEditablePost(session, id, owner);
    const next = { ...session, accessToken: "next-synthetic-incarnation" };
    store.updateSession(next);
    expect(store.record(post)).toBe(false);
    await expect(api.saveMobilePostEdit(next, post, { content: "Must not send" })).rejects.toMatchObject({ outcome: "not_applied" });
    expect(f.calls.filter(c => c.method === "PATCH")).toHaveLength(0);
});
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(test: () => boolean) { const end = Date.now() + 500; while (!test() && Date.now() < end)
    await Bun.sleep(1); expect(test()).toBe(true); }
test("an edit made during a real save/ACK remains an unsaved newer draft", async () => {
    const { createPostEditController } = await import("../src/post-edit-controller.ts");
    const f = fixture(), held = gate();
    let receipts = 0;
    const c = createPostEditController({ session, postId: id, authorId: owner, onReceipt: () => { receipts++; } });
    try {
        await c.show();
        c.setField("content", "Submitted edit");
        f.holdPatch(held.promise);
        const pending = c.save();
        await until(() => f.calls.some(r => r.method === "PATCH"));
        c.setField("content", "Newer draft");
        held.resolve();
        await pending;
        expect(f.content()).toBe("Submitted edit");
        expect(c.getState().draft.content).toBe("Newer draft");
        expect(c.getState().dirty).toBe(true);
        expect(c.getState().canSave).toBe(true);
        expect(receipts).toBe(2);
        expect(c.getState().status).toContain("新しい変更はまだ保存されていません");
    }
    finally {
        held.resolve();
        c.dispose();
    }
});
test("unknown edit outcomes require an explicit GET and cannot replay PATCH", async () => {
    const { createPostEditController } = await import("../src/post-edit-controller.ts");
    const f = fixture(), c = createPostEditController({ session, postId: id, authorId: owner });
    try {
        await c.show();
        c.setField("content", "Keep this change");
        f.failPatch(Response.json({ error: "Receipt unavailable" }, { status: 503 }));
        await c.save();
        expect(c.getState().uncertain).toBe(true);
        expect(c.getState().draft.content).toBe("Keep this change");
        await c.save();
        expect(f.calls.filter(r => r.method === "PATCH")).toHaveLength(1);
        await c.reload();
        expect(c.getState().uncertain).toBe(false);
        expect(c.getState().draft.content).toBe("Keep this change");
        expect(c.getState().dirty).toBe(true);
        expect(f.calls.filter(r => r.method === "PATCH")).toHaveLength(1);
    }
    finally {
        c.dispose();
    }
});
test("covering the editor retires a pending ACK but retains its draft and unknown outcome", async () => {
    const { createPostEditController } = await import("../src/post-edit-controller.ts");
    const f = fixture(), held = gate(), c = createPostEditController({ session, postId: id, authorId: owner });
    try {
        await c.show();
        c.setField("content", "Committed before cover");
        f.holdPatch(held.promise);
        const pending = c.save();
        await until(() => f.calls.some(r => r.method === "PATCH"));
        c.pause();
        held.resolve();
        await pending;
        const reads = f.calls.length;
        await c.show();
        expect(f.calls).toHaveLength(reads);
        expect(c.getState().uncertain).toBe(true);
        expect(c.getState().draft.content).toBe("Committed before cover");
        await c.reload();
        expect(c.getState().uncertain).toBe(false);
        expect(c.getState().dirty).toBe(false);
        expect(f.calls.filter(r => r.method === "PATCH")).toHaveLength(1);
    }
    finally {
        held.resolve();
        c.dispose();
    }
});
test("discard confirmation cannot erase edits typed while that confirmation is pending", async () => {
    const { createPostEditController } = await import("../src/post-edit-controller.ts");
    const f = fixture(), confirmation = gate<boolean>();
    const c = createPostEditController({ session, postId: id, authorId: owner, confirmDiscard: () => confirmation.promise });
    try {
        await c.show();
        c.setField("content", "Old draft");
        const resetting = c.discardAndReload();
        c.setField("content", "New while confirming");
        confirmation.resolve(true);
        await resetting;
        expect(c.getState().draft.content).toBe("New while confirming");
        expect(c.getState().dirty).toBe(true);
        expect(f.calls.filter(r => r.method === "PATCH")).toHaveLength(0);
    }
    finally {
        confirmation.resolve(false);
        c.dispose();
    }
});
test("changing only the selected API endpoint retires the old post editing scope", async () => {
    const { createNotificationController } = await import("../src/notification-controller.ts");
    fixture();
    const c = createNotificationController({ session });
    try {
        await c.openPost(id);
        expect(c.getState().page).toBe("post");
        expect(c.getState().post?.ap_id).toBe(id);
        c.updateSession({ ...session, apiBaseUrl: "https://next-api.fixture.test" });
        expect(c.getState().page).toBe("home");
        expect(c.getState().post).toBeUndefined();
    }
    finally {
        c.dispose();
    }
});
test("the detail owns an inline editor, preserves reply drafts, and adopts only confirmed text", async () => {
    const { createNotificationController } = await import("../src/notification-controller.ts");
    const f = fixture(), c = createNotificationController({ session, getActorId: () => owner });
    try {
        await c.openPost(id);
        c.getReplyComposer()!.setDraft("Keep this reply");
        expect(c.canEditPost()).toBe(false);
        await c.editOwnPost();
        expect(c.getPostEditor()).toBeUndefined();
        expect(c.getReplyComposer()!.getState().content).toBe("Keep this reply");
        c.getReplyComposer()!.setDraft("");
        await c.editOwnPost();
        expect(c.getState().postEdit?.visible).toBe(true);
        expect(c.getState().postEdit?.draft.content).toBe(f.content());
        expect(c.canDeletePost()).toBe(false);
        c.getPostEditor()!.setField("content", "Confirmed detail content");
        await c.getPostEditor()!.save();
        expect(c.getState().post?.content).toBe("Confirmed detail content");
        expect(c.getState().post?.bookmarkState).toBe(false);
        c.getPostEditor()!.hide();
        expect(c.canDeletePost()).toBe(true);
    }
    finally {
        c.dispose();
    }
});
test("declining post navigation preserves the edit without requesting a new target", async () => {
    const { createNotificationController } = await import("../src/notification-controller.ts");
    const f = fixture(), c = createNotificationController({ session, getActorId: () => owner, confirmDiscardPostEdit: () => false });
    try {
        await c.openPost(id);
        await c.editOwnPost();
        c.getPostEditor()!.setField("content", "Keep my edit");
        const before = f.calls.length;
        await c.openReply(base + "/ap/posts/another");
        expect(c.getState().post?.ap_id).toBe(id);
        expect(c.getPostEditor()!.getState().draft.content).toBe("Keep my edit");
        expect(f.calls).toHaveLength(before);
    }
    finally {
        c.dispose();
    }
});
test("an unrelated field changed by another writer survives a partial edit", async () => {
    const api = await import("../src/post-edit-api.ts"), f = fixture();
    const before = await api.loadMobileEditablePost(session, id, owner);
    f.changeSummary("Other writer's warning");
    const saved = await api.saveMobilePostEdit(session, before, { content: "My new content" });
    expect(saved.summary).toBe("Other writer's warning");
    expect(f.calls.filter(call => call.method === "PATCH").map(call => call.body)).toEqual([{ content: "My new content" }]);
});
test("missing warning metadata cannot be defaulted into a writable empty warning", async () => {
    const api = await import("../src/post-edit-api.ts");
    fixture();
    const fetchWire = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetchWire(input, init);
        if (new URL(String(input)).pathname.startsWith("/api/posts/")) {
            const wire = await response.json();
            delete wire.post.summary;
            return Response.json(wire);
        }
        return response;
    }) as typeof fetch;
    await expect(api.loadMobileEditablePost(session, id, owner)).rejects.toMatchObject({ outcome: "not_applied" });
});
test("the edit owner can cancel a real PATCH body after headers", async () => {
    const api = await import("../src/post-edit-api.ts");
    const headers = gate(), aborted = gate();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, fetch(request) {
            if (new URL(request.url).pathname === "/api/auth/me")
                return Response.json({ actor: { ap_id: owner } });
            if (request.method !== "PATCH")
                return Response.json({ post: { ap_id: id, type: "Note", author: { ap_id: owner }, content: "Original", summary: null, edited_at: null } });
            request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
            return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"success":')); } }), { headers: { "content-type": "application/json" } });
        } });
    const selected = { ...session, hostUrl: server.url.origin }, abort = new AbortController();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await originalFetch(input, init);
        if (init?.method === "PATCH")
            headers.resolve();
        return response;
    }) as typeof fetch;
    const before = await api.loadMobileEditablePost(selected, id, owner);
    const pending = api.saveMobilePostEdit(selected, before, { content: "Submitted" }, abort.signal).catch(cause => cause);
    try {
        await headers.promise;
        abort.abort(Error("view covered"));
        const result = await Promise.race([pending, Bun.sleep(500).then(() => "pending")]);
        expect(result).toBeInstanceOf(api.MobilePostEditError);
        expect(result.outcome).toBe("unknown");
        expect(await Promise.race([aborted.promise.then(() => true), Bun.sleep(500).then(() => false)])).toBe(true);
    }
    finally {
        abort.abort();
        server.stop(true);
        await pending;
    }
});
test("opening profile settings retires the covered post editor and retains its uncertain draft", async () => {
    const { createProfileController } = await import("../src/profile-controller.ts");
    const f = fixture(), held = gate();
    const profiles = createProfileController({ session, getActorId: () => owner });
    let pending: Promise<void> | undefined;
    try {
        await profiles.open(owner);
        const posts = profiles.getPostController();
        await posts.openPost(id);
        await posts.editOwnPost();
        posts.getPostEditor()!.setField("content", "Keep covered post edit");
        f.holdPatch(held.promise);
        pending = posts.getPostEditor()!.save();
        await until(() => f.calls.some(r => r.method === "PATCH"));
        await profiles.getEditor().show(owner);
        expect(posts.getState().postEdit?.visible).toBe(false);
        expect(posts.getPostEditor()!.getState().uncertain).toBe(true);
        held.resolve();
        await pending;
        profiles.getEditor().pause();
        await posts.editOwnPost();
        expect(posts.getPostEditor()!.getState().draft.content).toBe("Keep covered post edit");
        expect(posts.getPostEditor()!.getState().uncertain).toBe(true);
        expect(f.calls.filter(r => r.method === "PATCH")).toHaveLength(1);
    }
    finally {
        held.resolve();
        await pending;
        profiles.dispose();
    }
});
test("switching only API base retires the old shared feed operation as well", async () => {
    const { createFeedController } = await import("../src/feed-controller.ts");
    const ack = gate<Response>();
    let refreshes = 0, posts = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => { posts++; return ack.promise; }) as typeof fetch;
    const c = createFeedController({ session, refreshHome: async () => { refreshes++; } });
    let pending: Promise<void> | undefined;
    try {
        c.setDraft("Old endpoint draft");
        pending = c.submit();
        c.updateSession({ ...session, apiBaseUrl: "https://next-api.fixture.test" });
        c.setDraft("Current endpoint draft");
        ack.resolve(Response.json({ post: { ap_id: id } }));
        await pending;
        expect(c.getState().content).toBe("Current endpoint draft");
        expect(c.getState().status).toBe("");
        expect(refreshes).toBe(0);
        expect(posts).toBe(1);
    }
    finally {
        ack.resolve(Response.json({ post: { ap_id: id } }));
        await pending;
        c.dispose();
    }
});
test("a delayed refresh failure cannot overwrite the next confirmed save", async () => {
    const { createPostEditController } = await import("../src/post-edit-controller.ts");
    const f = fixture();
    let reject!: (cause: Error) => void, refreshes = 0;
    const lateRefresh = new Promise<void>((_, no) => { reject = no; });
    const c = createPostEditController({ session, postId: id, authorId: owner, onSaved: async () => { refreshes++; if (refreshes === 1)
            await lateRefresh; } });
    try {
        await c.show();
        c.setField("content", "First confirmed edit");
        const first = c.save();
        await until(() => refreshes === 1);
        c.setField("content", "Second confirmed edit");
        await c.save();
        reject(Error("old refresh failed"));
        await first;
        expect(c.getState().draft.content).toBe("Second confirmed edit");
        expect(c.getState().uncertain).toBe(false);
        expect(c.getState().refreshError).toBe("");
        expect(c.getState().status).toBe("投稿を保存しました。");
        expect(f.calls.filter(r => r.method === "PATCH")).toHaveLength(2);
    }
    finally {
        reject(Error("released"));
        c.dispose();
    }
});

test("a pending navigation confirmation cannot discard a newer post edit", async () => {
    const { createNotificationController } = await import("../src/notification-controller.ts");
    const f = fixture(), answer = gate<boolean>();
    const c = createNotificationController({ session, getActorId: () => owner, confirmDiscardPostEdit: () => answer.promise });
    try {
        await c.openPost(id);await c.editOwnPost();c.getPostEditor()!.setField("content", "Draft before dialog");
        const before = f.calls.length;
        const moving = c.openReply(base + "/ap/posts/another");
        c.getPostEditor()!.setField("content", "New draft while deciding");answer.resolve(true);await moving;
        expect(c.getPostEditor()?.getState().draft.content).toBe("New draft while deciding");
        expect(c.getState().post?.ap_id).toBe(id);
        expect(f.calls).toHaveLength(before);
    } finally { answer.resolve(false);c.dispose(); }
});

test("a profile switch confirmation cannot discard a reopened newer post edit", async () => {
    const { createProfileController } = await import("../src/profile-controller.ts");
    fixture();const fetchWire = globalThis.fetch, answer = gate<boolean>(), other = base + "/ap/users/other";
    let confirming = false, declined = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname === "/api/actors/" + encodeURIComponent(other))
            return Response.json({ actor: { ap_id: other, preferred_username: "other", username: "other", name: null, summary: null, icon_url: null, header_url: null, post_count: 0, follower_count: 0, following_count: 0, fields: [], is_private: false } });
        if (new URL(String(input)).pathname === "/api/actors/" + encodeURIComponent(other) + "/posts")
            return Response.json({ posts: [], has_more: false, next_cursor: null });
        return fetchWire(input, init);
    }) as typeof fetch;
    const profiles = createProfileController({ session, getActorId: () => owner, onDeclined: () => { declined++; }, confirmDiscardPostEdit: () => { confirming = true;return answer.promise; } });
    try {
        await profiles.open(owner);const posts = profiles.getPostController();await posts.openPost(id);await posts.editOwnPost();
        posts.getPostEditor()!.setField("content", "Before actor switch");const moving = profiles.open(other);
        await until(() => confirming);await posts.editOwnPost();posts.getPostEditor()!.setField("content", "New edit while deciding");
        answer.resolve(true);await moving;
        expect(profiles.getState().actor?.ap_id).toBe(owner);
        expect(profiles.getPostController().getPostEditor()?.getState().draft.content).toBe("New edit while deciding");
        expect(declined).toBe(0);
        // A fresh confirmation of the now-current draft can still navigate.
        expect(await profiles.open(other)).toBe(true);
        expect(profiles.getState().actor?.ap_id).toBe(other);
        expect(profiles.getPostController().getPostEditor()).toBeUndefined();
    } finally { answer.resolve(false);profiles.dispose(); }
});
