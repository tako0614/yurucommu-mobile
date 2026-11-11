import { normalizeHostUrl, type MobileSession } from "@takosjp/mobile-kit";
import { PostEditRecoveryError, type PostEditRecoveryPort, type PostEditRecoverySnapshot, type PostEditInvalidRecoveryReview } from "./post-edit-recovery.ts";
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
    readonly recovery?: { readonly ready: boolean; readonly saving: boolean; readonly error: string;
        readonly attempted?: MobilePostEditPatch; readonly conflicts: readonly (keyof MobilePostEditForm)[]; readonly canConfirmReview: boolean;
        readonly canReviewInvalid: boolean; readonly reviewingInvalid: boolean; readonly discardingInvalid: boolean; readonly invalidReview: boolean };
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
    recovery?: () => PostEditRecoveryPort;
    recoveryView?: "post" | "profile";
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
    let recoveryPort: PostEditRecoveryPort | undefined, recoveryLoaded = !options.recovery, recoveryError = "";
    let recoveryRevision = 0, savedRecoveryRevision = 0, recoverySaving = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined, flushing: Promise<boolean> | undefined;
    let recoveryBase: MobilePostEditForm | undefined, recoveryReviewed = false, confirmingRecovery = false;
    let recoveryConflicts: (keyof MobilePostEditForm)[] = [];
    let recoveryInvalid = false, reviewingInvalid = false, discardingInvalid = false, invalidReviewEpoch = 0;
    let invalidReview: { value: PostEditInvalidRecoveryReview; port: PostEditRecoveryPort; owner: number; revision: number; versions: typeof versions } | undefined;
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
            canSave: live() && !!base && recoveryLoaded && !recoveryError && !recoverySaving && !confirmingRecovery && !reviewingInvalid && !discardingInvalid && !invalidReview && !loading && !saving && !needsReload && !uncertain && !invalid && Object.keys(changed).length > 0,
            draft: { ...draft }, base, error: error || invalid, status, refreshError,
            recovery: options.recovery ? { ready: recoveryLoaded, saving: recoverySaving, error: recoveryError,
                attempted: attempted && { ...attempted.patch }, conflicts: [...recoveryConflicts],
                canConfirmReview: (!!attempted || !!recoveryConflicts.length) && recoveryReviewed && !loading && !saving && !recoverySaving && !confirmingRecovery && !reviewingInvalid && !discardingInvalid && !invalidReview,
                canReviewInvalid: live() && recoveryInvalid && !!recoveryPort && !loading && !saving && !recoverySaving && !confirmingRecovery && !reviewingInvalid && !discardingInvalid && !invalidReview,
                reviewingInvalid, discardingInvalid, invalidReview: !!invalidReview } : undefined };
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
        if (!live() || loading || saving || confirmingRecovery || reviewingInvalid || discardingInvalid)
            return false;
        const owner = ++generation, abort = new AbortController(), recovering = uncertain;
        pending = abort;
        loading = true;
        invalidReview = undefined;
        if (options.recovery) recoveryReviewed = false;
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
            const firstRead = !recoveryLoaded, previousBase = base ? postEditForm(base) : undefined;
            let restored = false;
            if (firstRead) {
                try {
                    recoveryPort = undefined;
                    const port = options.recovery!();
                    if (port.scope.product !== session.product || port.scope.hostUrl !== normalizeHostUrl(session.hostUrl) ||
                        port.scope.actorApId !== options.authorId || port.scope.postApId !== options.postId ||
                        port.scope.apiBaseUrl !== session.apiBaseUrl || port.scope.view !== (options.recoveryView ?? "post")) throw new Error("投稿編集の保存先が一致しません。");
                    recoveryPort = port;
                    const saved = await port.load(); if (!current(owner)) return false;
                    restored = !!saved; base = post; draft = postEditForm(post);
                    if (saved) {
                        for (const key of fields) if (saved.draft[key] !== saved.base[key]) draft[key] = saved.draft[key];
                        attempted = saved.attempted; recoveryBase = { ...saved.base };
                    }
                    recoveryLoaded = true; recoveryError = ""; recoveryInvalid = false;
                } catch (cause) {
                    if (current(owner)) {
                        recoveryInvalid = cause instanceof PostEditRecoveryError && cause.code === "invalid-data";
                        recoveryError = "保存した投稿編集を確認できませんでした。再確認まで保存を待機します。";
                    }
                    throw cause;
                }
            } else {
                if (recoveryInvalid && recoveryPort) {
                    const saved = await recoveryPort.load(); if (!current(owner)) return false;
                    // A lost delete ACK can be resolved by an explicit read.
                    // A different valid record is preserved, not implicitly replaced.
                    if (saved !== null) throw new PostEditRecoveryError("changed");
                    recoveryInvalid = false; recoveryError = "";
                }
                merge(post, resetVersions);
            }
            loading = false;
            if (options.recovery) {
                const before = recoveryBase ?? previousBase, latest = postEditForm(post);
                recoveryConflicts = before ? fields.filter(key => draft[key] !== before[key] && latest[key] !== before[key] && latest[key] !== draft[key] &&
                    !(attempted && key in attempted.patch && latest[key] === attempted.patch[key])) : [];
                if (attempted || recoveryConflicts.length) recoveryBase ??= before && { ...before };
                else recoveryBase = undefined;
                uncertain = !!attempted; needsReload = uncertain || recoveryConflicts.length > 0;
                recoveryReviewed = needsReload && !firstRead;
                if (restored || resetVersions || getState().dirty || attempted || recoveryBase) changedRecovery();
            } else { attempted = undefined; needsReload = false; uncertain = false; }
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
        if (!live() || loading || confirmingRecovery || !recoveryLoaded || (key !== "content" && key !== "summary") || typeof value !== "string")
            return;
        draft = { ...draft, [key]: value };
        versions[key]++;
        invalidReview = undefined;
        recoveryReviewed = false; changedRecovery();
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
        let dispatched = false;
        try {
            if (options.recovery) {
                changedRecovery();
                if (!await flushRecovery()) throw new MobilePostEditError("送信前に投稿編集の復旧情報を保存してください。", "not_applied");
                if (!current(owner)) return;
            }
            dispatched = true;
            const post = await saveMobilePostEdit(session, before, changed, abort.signal);
            if (!current(owner))
                return;
            merge(post, resetVersions);
            attempted = undefined;
            saving = false;
            needsReload = false;
            uncertain = false;
            if (options.recovery) { recoveryBase = undefined; recoveryReviewed = false; recoveryConflicts = []; changedRecovery(); await flushRecovery(); }
            if (!current(owner)) return;
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
                if (options.recovery) { recoveryReviewed = false; changedRecovery(); if (dispatched || !recoveryError) await flushRecovery(); }
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
        recoveryReviewed = false;
        invalidReview = undefined;
        if (recoveryLoaded && !recoveryInvalid && savedRecoveryRevision !== recoveryRevision) void flushRecovery();
        clearTimeout(recoveryTimer); recoveryTimer = undefined;
        visible = false;
        publish();
    }
    async function discardAndReload() {
        if (!live() || loading || saving || confirmingRecovery || (options.recovery && (!!attempted || recoveryConflicts.length > 0)))
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
        const finalWrite = flushing;
        disposed = true;
        const release = () => { base = null; draft = { content: "", summary: "" }; attempted = undefined; recoveryBase = undefined; };
        if (finalWrite) void finalWrite.then(release, release); else release();
    }
    function changedRecovery() {
        recoveryRevision++;
        if (!options.recovery || !recoveryLoaded || recoveryError || disposed) return;
        clearTimeout(recoveryTimer); recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void flushRecovery(); }, 150);
    }
    function flushRecovery(): Promise<boolean> {
        clearTimeout(recoveryTimer); recoveryTimer = undefined;
        if (flushing) return flushing;
        if (!options.recovery || disposed || !recoveryLoaded || !base || !recoveryPort || reviewingInvalid || discardingInvalid) return Promise.resolve(false);
        recoverySaving = true;
        flushing = Promise.resolve().then(async () => {
            try {
                let revision: number;
                do {
                    revision = recoveryRevision;
                    const data: PostEditRecoverySnapshot = { base: { ...(!confirmingRecovery && recoveryBase ? recoveryBase : postEditForm(base!)) }, draft: { ...draft },
                        ...(!confirmingRecovery && attempted ? { attempted: { draft: { ...attempted.draft }, patch: { ...attempted.patch } } } : {}) };
                    await recoveryPort!.save(data); savedRecoveryRevision = revision;
                } while (revision !== recoveryRevision);
                recoveryError = ""; recoveryInvalid = false; return true;
            } catch (cause) {
                if (!disposed) {
                    recoveryInvalid ||= cause instanceof PostEditRecoveryError && cause.code === "invalid-data";
                    recoveryError = "投稿編集の復旧情報を保存できませんでした。保存を再試行してください。";
                }
                return false;
            }
            finally { recoverySaving = false; flushing = undefined; publish(); }
        });
        publish(); return flushing;
    }
    async function confirmRecoveryReview() {
        if (!live() || !getState().recovery?.canConfirmReview) return;
        const owner = generation; confirmingRecovery = true; recoveryRevision++;
        try {
            if (await flushRecovery() && current(owner)) {
                attempted = undefined; uncertain = false; needsReload = false; recoveryReviewed = false; recoveryBase = undefined; recoveryConflicts = [];
                status = "現在の保存内容を確認しました。残った入力は、保存ボタンを押すまで送信しません。";
            }
        } finally { confirmingRecovery = false; publish(); }
    }
    async function reviewInvalidRecovery() {
        if (!getState().recovery?.canReviewInvalid || !recoveryPort) return;
        const port = recoveryPort, owner = generation, revision = recoveryRevision, input = { ...versions }, epoch = ++invalidReviewEpoch;
        reviewingInvalid = true; publish();
        try {
            const value = await port.reviewInvalid();
            if (current(owner) && recoveryPort === port && recoveryRevision === revision && invalidReviewEpoch === epoch)
                invalidReview = { value, port, owner, revision, versions: input };
        } catch {
            if (current(owner)) recoveryError = "保存範囲・破損内容を確認できませんでした。破棄せず、保存情報を再確認してください。";
        } finally { reviewingInvalid = false; publish(); }
    }
    async function discardInvalidRecovery() {
        const review = invalidReview;
        if (!review || !current(review.owner) || recoveryPort !== review.port || loading || saving || recoverySaving || confirmingRecovery || reviewingInvalid || discardingInvalid) return;
        invalidReview = undefined;
        if (review.revision !== recoveryRevision || fields.some(key => review.versions[key] !== versions[key])) {
            recoveryError = "入力が変わったため破棄を中止しました。現在の入力を保持しています。もう一度確認してください。";
            publish(); return;
        }
        discardingInvalid = true; publish();
        try {
            await review.value.discard();
            if (!current(review.owner) || recoveryPort !== review.port) return;
            recoveryInvalid = false; recoveryError = "";
            discardingInvalid = false;
            await read();
        } catch {
            if (current(review.owner)) recoveryError = "保存情報の破棄を確認できませんでした。入力を保持し、保存待機を続けます。再確認してください。";
        } finally { discardingInvalid = false; publish(); }
    }
    function cancelInvalidRecoveryReview() {
        if (discardingInvalid) return;
        invalidReview = undefined; invalidReviewEpoch++; publish();
    }
    return { getState, show, setField, save, reload: () => read(), discardAndReload, pause, hide: pause, dispose, flushRecovery, confirmRecoveryReview,
        reviewInvalidRecovery, discardInvalidRecovery, cancelInvalidRecoveryReview,
        getRevision: () => JSON.stringify([generation, versions.content, versions.summary]),
        hasDraft: () => getState().dirty || uncertain || saving };
}
export type PostEditController = ReturnType<typeof createPostEditController>;
