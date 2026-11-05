import type { MobileSession } from "@takosjp/mobile-kit";
import { snapshotFeedSession } from "./feed-session.ts";
import { loadMobileEditablePost, saveMobilePostEdit, changedPostEditFields, postEditForm, MobilePostEditError, type MobileEditablePost, type MobilePostEditForm, type MobilePostEditPatch, } from "./post-edit-api.ts";
const fields = ["content", "summary"] as const;
export interface MobilePostEditState {
    readonly visible: boolean;
    readonly loading: boolean;
    readonly saving: boolean;
    readonly needsReload: boolean;
    readonly uncertain: boolean;
    readonly dirty: boolean;
    readonly canSave: boolean;
    readonly draft: Readonly<MobilePostEditForm>;
    readonly base: MobileEditablePost | null;
    readonly error: string;
    readonly status: string;
    readonly refreshError: string;
}
export function createPostEditController(options: {
    session: MobileSession;
    postId: string;
    authorId: string;
    isActive?: () => boolean;
    onChange?: () => void;
    onReceipt?: (post: MobileEditablePost) => void;
    onSaved?: () => Promise<void>;
    confirmDiscard?: () => boolean | Promise<boolean>;
}) {
    const session = snapshotFeedSession(options.session);
    let disposed = false, visible = false, generation = 0;
    let base: MobileEditablePost | null = null;
    let draft: MobilePostEditForm = { content: "", summary: "" };
    const versions: Record<keyof MobilePostEditForm, number> = { content: 0, summary: 0 };
    let loading = false, saving = false, needsReload = false, uncertain = false;
    let error = "", status = "", refreshError = "", pending: AbortController | undefined;
    let attempted: {
        draft: MobilePostEditForm;
        patch: MobilePostEditPatch;
    } | undefined;
    const active = () => !disposed && options.isActive?.() !== false;
    const live = () => active() && visible;
    const current = (owner: number) => live() && generation === owner;
    const publish = () => { if (!disposed)
        options.onChange?.(); };
    const message = (cause: unknown) => cause instanceof Error ? cause.message : "投稿を確認できませんでした。";
    function patch() { return base ? changedPostEditFields(draft, base) : {}; }
    function getState(): MobilePostEditState {
        let changed: MobilePostEditPatch = {}, invalid = "";
        try {
            changed = patch();
        }
        catch (cause) {
            invalid = message(cause);
        }
        const dirty = !!base && fields.some(key => draft[key] !== postEditForm(base!)[key]);
        return { visible, loading, saving, needsReload, uncertain, dirty,
            canSave: live() && !!base && !loading && !saving && !needsReload && !uncertain && !invalid && Object.keys(changed).length > 0,
            draft: { ...draft }, base, error: error || invalid, status, refreshError };
    }
    function merge(post: MobileEditablePost, resetVersions?: typeof versions) {
        const previous = base ? postEditForm(base) : null, next = postEditForm(post), kept = { ...draft };
        for (const key of fields) {
            if (resetVersions ? versions[key] === resetVersions[key] :
                !previous || draft[key] === previous[key] ||
                    (attempted && key in attempted.patch && draft[key] === attempted.draft[key] && next[key] === attempted.patch[key]))
                kept[key] = next[key];
        }
        base = post;
        draft = kept;
    }
    async function refresh(owner: number) {
        try {
            await options.onSaved?.();
        }
        catch {
            if (current(owner)) {
                refreshError = "投稿の保存は確認済みです。一覧を更新できませんでした。";
                publish();
            }
        }
    }
    async function read(resetVersions?: typeof versions): Promise<boolean> {
        if (!live() || loading || saving)
            return false;
        const owner = ++generation, abort = new AbortController(), recovering = uncertain;
        pending = abort;
        loading = true;
        error = "";
        status = "";
        refreshError = "";
        publish();
        if (!current(owner))
            return false;
        try {
            const post = await loadMobileEditablePost(session, options.postId, options.authorId, abort.signal);
            if (!current(owner))
                return false;
            merge(post, resetVersions);
            attempted = undefined;
            loading = false;
            needsReload = false;
            uncertain = false;
            status = getState().dirty ? "現在の保存状態を確認しました。入力中の変更はまだ保存されていません。" : "現在の保存状態を確認しました。";
            options.onReceipt?.(post);
            if (!current(owner))
                return false;
            publish();
            if (current(owner) && recovering)
                await refresh(owner);
        }
        catch (cause) {
            if (current(owner)) {
                loading = false;
                needsReload = true;
                error = message(cause);
                publish();
            }
        }
        finally {
            if (pending === abort)
                pending = undefined;
        }
        return current(owner);
    }
    async function show() {
        if (!active())
            return;
        visible = true;
        if (base && (getState().dirty || uncertain || needsReload)) {
            publish();
            return;
        }
        await read();
    }
    function setField(key: keyof MobilePostEditForm, value: string) {
        if (!live() || loading || (key !== "content" && key !== "summary") || typeof value !== "string")
            return;
        draft = { ...draft, [key]: value };
        versions[key]++;
        error = "";
        status = "";
        publish();
    }
    async function save() {
        if (!getState().canSave || !base)
            return;
        const submitted = { ...draft }, changed = patch(), before = base, resetVersions = { ...versions };
        const owner = ++generation, abort = new AbortController();
        pending = abort;
        attempted = { draft: submitted, patch: changed };
        saving = true;
        error = "";
        status = "";
        refreshError = "";
        publish();
        if (!current(owner))
            return;
        try {
            const post = await saveMobilePostEdit(session, before, changed, abort.signal);
            if (!current(owner))
                return;
            merge(post, resetVersions);
            attempted = undefined;
            saving = false;
            needsReload = false;
            uncertain = false;
            status = getState().dirty ? "送信した変更は保存済みです。新しい変更はまだ保存されていません。" : "投稿を保存しました。";
            try {
                options.onReceipt?.(post);
            }
            catch {
                refreshError = "投稿の保存は確認済みです。画面を更新できませんでした。";
            }
            if (!current(owner))
                return;
            publish();
            if (current(owner))
                await refresh(owner);
        }
        catch (cause) {
            if (current(owner)) {
                saving = false;
                needsReload = true;
                uncertain = !(cause instanceof MobilePostEditError && cause.outcome === "not_applied");
                if (!uncertain)
                    attempted = undefined;
                error = uncertain ? `保存結果が不明です。自動再送せず、現在の保存状態を確認してください。 ${message(cause)}` : message(cause);
                publish();
            }
        }
        finally {
            if (pending === abort)
                pending = undefined;
        }
    }
    function pause() {
        if (disposed)
            return;
        generation++;
        pending?.abort();
        pending = undefined;
        if (loading || saving) {
            needsReload = true;
            uncertain ||= saving;
            error = saving ? "保存結果が不明です。現在の保存状態を確認してください。" : "投稿の読み込みを中断しました。";
        }
        loading = false;
        saving = false;
        visible = false;
        publish();
    }
    async function discardAndReload() {
        if (!live() || loading || saving)
            return;
        const owner = generation, resetVersions = { ...versions };
        let accepted = false;
        try {
            accepted = (await options.confirmDiscard?.()) ?? false;
        }
        catch { }
        if (accepted && current(owner))
            await read(resetVersions);
    }
    function dispose() {
        if (disposed)
            return;
        pause();
        disposed = true;
        base = null;
        draft = { content: "", summary: "" };
        attempted = undefined;
    }
    return { getState, show, setField, save, reload: () => read(), discardAndReload, pause, hide: pause, dispose,
        getRevision: () => JSON.stringify([generation, versions.content, versions.summary]),
        hasDraft: () => getState().dirty || uncertain || saving };
}
export type PostEditController = ReturnType<typeof createPostEditController>;
