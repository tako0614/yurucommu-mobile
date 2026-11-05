import type { MobileSession } from "@takosjp/mobile-kit";
import { apiFetch } from "@takosjp/yurucommu-api";
import { readMobileResponseJson, withMobileApiTransport, recordMobilePostLikeRead, mobilePostLikeReadStartedAt } from "./api.ts";
import { snapshotFeedSession } from "./feed-session.ts";
import { validMobileActorApId } from "./profile-api.ts";
export interface MobileEditablePost {
    readonly ap_id: string;
    readonly authorId: string;
    readonly content: string;
    readonly summary: string | null;
    readonly edited_at: string | null;
    readonly readStartedAt: number;
}
export interface MobilePostEditForm {
    content: string;
    summary: string;
}
export type MobilePostEditPatch = Partial<MobilePostEditForm>;
export const POST_EDIT_CONTENT_LIMIT = 5000;
export const POST_EDIT_SUMMARY_LIMIT = 500;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export class MobilePostEditError extends Error {
    constructor(message: string, readonly outcome: "not_applied" | "unknown", cause?: unknown) {
        super(message, { cause });
        this.name = "MobilePostEditError";
    }
}
export const postEditForm = (post: MobileEditablePost): MobilePostEditForm => ({ content: post.content, summary: post.summary ?? "" });
export function normalizePostEditPatch(input: MobilePostEditPatch): MobilePostEditPatch {
    if (!record(input) || Object.keys(input).some(key => key !== "content" && key !== "summary"))
        throw new MobilePostEditError("本文と内容警告だけを編集できます。", "not_applied");
    const patch: MobilePostEditPatch = {};
    for (const key of ["content", "summary"] as const) {
        if (input[key] === undefined)
            continue;
        if (typeof input[key] !== "string")
            throw new MobilePostEditError("編集する文字列が不正です。", "not_applied");
        const value = input[key].trim(), max = key === "content" ? POST_EDIT_CONTENT_LIMIT : POST_EDIT_SUMMARY_LIMIT;
        if ((key === "content" && !value) || value.length > max)
            throw new MobilePostEditError(key === "content" ? `本文は1〜${max}文字で入力してください。` : `内容警告は${max}文字以内で入力してください。`, "not_applied");
        patch[key] = value;
    }
    return patch;
}
export function changedPostEditFields(draft: MobilePostEditForm, base: MobileEditablePost): MobilePostEditPatch {
    const previous = postEditForm(base), changed: MobilePostEditPatch = {};
    for (const key of ["content", "summary"] as const)
        if (draft[key] !== previous[key])
            changed[key] = draft[key];
    const normalized = normalizePostEditPatch(changed);
    for (const key of ["content", "summary"] as const)
        if (normalized[key] === previous[key])
            delete normalized[key];
    return normalized;
}
type Request = (path: string, method?: string, body?: string) => Promise<Response>;
async function scope<T>(session: MobileSession, signal: AbortSignal | undefined, run: (request: Request) => Promise<T>): Promise<T> {
    const selected = snapshotFeedSession(session), owned = new AbortController();
    const cancel = () => owned.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted)
        cancel();
    const deadline = setTimeout(() => owned.abort(Error("投稿の保存状態を時間内に確認できませんでした。")), 15000);
    const request: Request = (path, method = "GET", body) => {
        owned.signal.throwIfAborted();
        return withMobileApiTransport(selected, () => apiFetch(path, {
            method, body, ...(body ? { headers: { "content-type": "application/json" } } : {}),
            signal: owned.signal, timeoutMs: 0, credentials: "omit", redirect: "error", cache: "no-store",
        }));
    };
    try {
        const result = await run(request);
        owned.signal.throwIfAborted();
        return result;
    }
    finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancel);
        owned.abort();
    }
}
async function json(response: Response, maximum = 128 * 1024) {
    if (!response.ok) {
        await response.body?.cancel();
        throw Error(`投稿を確認できませんでした（${response.status}）。`);
    }
    return readMobileResponseJson(response, maximum, "投稿の編集");
}
async function verifyViewer(request: Request, author: string) {
    const me = await json(await request("/api/auth/me"));
    if (!record(me) || !record(me.actor) || me.actor.ap_id !== author)
        throw Error("現在の本人が投稿者と一致しません。変更は送信していません。");
}
async function canonical(request: Request, id: string, author: string): Promise<MobileEditablePost> {
    const readStartedAt = performance.now(), raw = await json(await request("/api/posts/" + encodeURIComponent(id)), 512 * 1024);
    if (!record(raw) || !record(raw.post))
        throw Error("投稿の応答を確認できませんでした。");
    const post = raw.post;
    if (post.ap_id !== id || post.type !== "Note" || !record(post.author) || post.author.ap_id !== author ||
        typeof post.content !== "string" || !(post.summary === null || typeof post.summary === "string") ||
        !(post.edited_at === undefined || post.edited_at === null || (typeof post.edited_at === "string" && Number.isFinite(Date.parse(post.edited_at)))))
        throw Error("本文・内容警告・投稿者を確認できませんでした。未確認の値では編集しません。");
    return { ap_id: id, authorId: author, content: post.content, summary: post.summary as string | null, edited_at: (post.edited_at ?? null) as string | null, readStartedAt };
}
function validateIdentity(id: string, author: string) {
    if (!validMobileActorApId(id) || !validMobileActorApId(author))
        throw new MobilePostEditError("編集する投稿の識別子が不正です。", "not_applied");
}
export async function loadMobileEditablePost(session: MobileSession, id: string, author: string, signal?: AbortSignal): Promise<MobileEditablePost> {
    validateIdentity(id, author);
    const selected = snapshotFeedSession(session);
    try {
        const post = await scope(selected, signal, async (request) => { await verifyViewer(request, author); return canonical(request, id, author); });
        return recordMobilePostLikeRead(post, selected, post.readStartedAt);
    }
    catch (cause) {
        throw new MobilePostEditError(cause instanceof Error ? cause.message : "投稿を確認できませんでした。", "not_applied", cause);
    }
}
/** Preflight detects already-changed fields. The existing server has no atomic edit CAS. */
export async function saveMobilePostEdit(session: MobileSession, base: MobileEditablePost, input: MobilePostEditPatch, signal?: AbortSignal): Promise<MobileEditablePost> {
    validateIdentity(base.ap_id, base.authorId);
    const selected = snapshotFeedSession(session);
    if (mobilePostLikeReadStartedAt(base, selected) === null)
        throw new MobilePostEditError("編集元の接続先が変わりました。現在の投稿を読み直してください。", "not_applied");
    const patch = normalizePostEditPatch(input), keys = Object.keys(patch) as (keyof MobilePostEditForm)[];
    if (!keys.length)
        throw new MobilePostEditError("変更された項目がありません。", "not_applied");
    let dispatched = false;
    try {
        const saved = await scope(selected, signal, async (request) => {
            await verifyViewer(request, base.authorId);
            const fresh = await canonical(request, base.ap_id, base.authorId);
            for (const key of keys)
                if (postEditForm(fresh)[key] !== postEditForm(base)[key])
                    throw Error("編集した項目は別の操作で変更されています。現在の保存状態を確認してください。");
            dispatched = true;
            const response = await request("/api/posts/" + encodeURIComponent(base.ap_id), "PATCH", JSON.stringify(patch));
            if ([400, 401, 403, 404].includes(response.status)) {
                await response.body?.cancel();
                throw new MobilePostEditError(`投稿を保存できませんでした（${response.status}）。`, "not_applied");
            }
            const ack = await json(response, 64 * 1024);
            if (!record(ack) || ack.success !== true || !record(ack.post) || ack.post.ap_id !== base.ap_id ||
                typeof ack.post.content !== "string" || !(ack.post.summary === null || typeof ack.post.summary === "string"))
                throw Error("投稿の保存応答を確認できませんでした。");
            for (const key of keys)
                if (ack.post[key] !== (key === "summary" && patch[key] === "" ? null : patch[key]))
                    throw Error("投稿の保存応答が送信した変更と一致しません。");
            const saved = await canonical(request, base.ap_id, base.authorId);
            for (const key of keys)
                if (postEditForm(saved)[key] !== patch[key])
                    throw Error("送信後の保存状態が一致しません。現在の投稿を確認してください。");
            return saved;
        });
        return recordMobilePostLikeRead(saved, selected, saved.readStartedAt);
    }
    catch (cause) {
        if (cause instanceof MobilePostEditError)
            throw cause;
        throw new MobilePostEditError(cause instanceof Error ? cause.message : "投稿を保存できませんでした。", dispatched ? "unknown" : "not_applied", cause);
    }
}
