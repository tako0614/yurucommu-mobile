import { normalizeHostUrl, type MobileSession } from "@takosjp/mobile-kit";
import { snapshotFeedSession } from "./feed-session.ts";
import { uploadPostMedia, type MobileUploadedAttachment } from "./api.ts";
import {
  loadMobileEditableProfile,
  saveMobileProfile,
  changedProfileFields,
  profileForm,
  profileFormKeys,
  type MobileProfileForm,
  type MobileProfilePatch,
} from "./profile-edit-api.ts";
import type { MobileProfile } from "./profile-api.ts";
import type { ProfileRecoveryPort, ProfileRecoverySnapshot } from "./profile-recovery.ts";
type ImageKey = "icon_url" | "header_url";
interface Upload {
  name: string;
  phase: "uploading" | "ready" | "error" | "reselect";
  error: string;
  saved?: boolean;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const copy = (v: MobileProfileForm): MobileProfileForm => ({
  ...v,
  fields: v.fields.map((row) => ({ ...row })),
});
const empty = (): MobileProfileForm => ({
  name: "",
  summary: "",
  icon_url: "",
  header_url: "",
  is_private: false,
  fields: [],
});
export function createProfileEditController(options: {
  session: MobileSession;
  isActive?: () => boolean;
  onChange?: () => void;
  onReceipt?: (actor: MobileProfile) => void;
  onSaved?: () => Promise<void>;
  confirmDiscard?: () => boolean | Promise<boolean>;
  recovery?: () => ProfileRecoveryPort;
}) {
  const session = snapshotFeedSession(options.session);
  let recoveryPort: ProfileRecoveryPort | undefined, recoveryLoaded = !options.recovery, recoveryError = "";
  let recoverySaving = 0, recoveryRevision = 0, savedRecoveryRevision = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryReviewBase: MobileProfileForm | undefined, recoveryReviewed = false, confirmingRecovery = false;
  let recoveryConflicts: (keyof MobileProfileForm)[] = [];
  const fieldVersions = Object.fromEntries(
    profileFormKeys.map((key) => [key, 0]),
  ) as Record<keyof MobileProfileForm, number>;
  let disposed = false,
    visible = false,
    generation = 0,
    revision = 0,
    actorId: string | null = null,
    base: MobileProfile | null = null,
    draft = empty();
  let loading = false,
    saving = false,
    needsReload = false,
    uncertain = false,
    error = "",
    message = "",
    refreshError = "",
    pending: AbortController | undefined;
  let attempted:
    { draft: MobileProfileForm; patch: MobileProfilePatch } | undefined;
  const uploads: Partial<Record<ImageKey, Upload>> = {},
    files: Partial<Record<ImageKey, File>> = {},
    uploaded: Partial<Record<ImageKey, MobileUploadedAttachment>> = {},
    imageReads: Partial<Record<ImageKey, AbortController>> = {},
    imageVersions: Record<ImageKey, number> = { icon_url: 0, header_url: 0 };
  const live = () => !disposed && visible && options.isActive?.() !== false;
  const current = (owner: number) => live() && generation === owner;
  const imageBusy = () =>
    Object.values(uploads).some((v) => v?.phase === "uploading");
  const publish = () => {
    if (!disposed) options.onChange?.();
  };
  function patch() {
    if (!base) return {};
    const value = changedProfileFields(draft, profileForm(base));
    for (const key of ["icon_url", "header_url"] as const) {
      const file = uploaded[key];
      if (
        value[key] !== undefined &&
        file?.url === draft[key] &&
        file.expiresAt &&
        Date.parse(file.expiresAt) <= Date.now()
      )
        throw Error(
          "画像の有効期限が切れています。再アップロードしてください。",
        );
    }
    return value;
  }
  function getState() {
    let validation = "",
      changes: MobileProfilePatch = {};
    try {
      changes = patch();
    } catch (cause) {
      validation = cause instanceof Error ? cause.message : "入力が不正です。";
    }
    return {
      visible,
      actorId,
      loaded: base !== null,
      loading,
      saving,
      needsReload,
      uncertain,
      error,
      message,
      refreshError,
      validation,
      draft: copy(draft),
      uploads: { ...uploads },
      dirty: !!base && !same(draft, profileForm(base)),
      recovery: options.recovery ? { ready: recoveryLoaded, error: recoveryError, saving: recoverySaving > 0,
        attempted: attempted ? { draft: copy(attempted.draft), patch: { ...attempted.patch,
          ...(attempted.patch.fields ? { fields: attempted.patch.fields.map(row => ({ ...row })) } : {}) } } : undefined,
        conflicts: [...recoveryConflicts], current: base ? profileForm(base) : undefined,
        canConfirmReview: (!!attempted || !!recoveryConflicts.length) && recoveryReviewed && !loading && !saving && !recoverySaving && !confirmingRecovery } : undefined,
      canSave:
        (recoveryLoaded && !recoveryError && !confirmingRecovery && !recoverySaving) &&
        live() &&
        !!base &&
        !loading &&
        !saving &&
        !imageBusy() &&
        !Object.values(uploads).some((v) => v?.phase === "error" || v?.phase === "reselect") &&
        !needsReload &&
        !validation &&
        Object.keys(changes).length > 0,
      busy: loading || saving || imageBusy(),
    };
  }
  function stopImages() {
    for (const key of ["icon_url", "header_url"] as const) {
      imageVersions[key]++;
      imageReads[key]?.abort();
      delete imageReads[key];
      if (uploads[key]?.phase === "uploading")
        uploads[key] = {
          ...uploads[key]!,
          phase: "error",
          error: "アップロードを中断しました。必要なら再試行してください。",
        };
    }
  }
  function pause() {
    recoveryReviewed = false;
    if (recoveryLoaded && savedRecoveryRevision !== recoveryRevision) void flushRecovery();
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    generation++;
    pending?.abort();
    pending = undefined;
    stopImages();
    if (loading || saving) {
      needsReload = true;
      error = saving
        ? "保存結果が不明です。現在の保存状態を確認してください。"
        : "プロフィールの読み込みを中断しました。";
    }
    loading = false;
    saving = false;
    visible = false;
    publish();
  }
  function merge(
    actor: MobileProfile,
    resetVersions?: Record<keyof MobileProfileForm, number>,
    attempt = attempted,
  ) {
    const previous = base ? profileForm(base) : null,
      next = profileForm(actor),
      kept = copy(draft);
    for (const key of profileFormKeys) {
      if (
        resetVersions
          ? fieldVersions[key] === resetVersions[key]
          : !previous ||
            same(draft[key], previous[key]) ||
            (attempt &&
              key in attempt.patch &&
              same(draft[key], attempt.draft[key]) &&
              same(next[key], attempt.patch[key]))
      )
        Object.assign(kept, { [key]: next[key] });
    }
    for (const key of ["icon_url", "header_url"] as const) {
      const view = uploads[key];
      if (view?.phase === "ready")
        uploads[key] = { ...view, saved: uploaded[key]?.url === actor[key] };
    }
    base = actor;
    draft = copy(kept);
  }
  async function refresh(owner: number) {
    try {
      await options.onSaved?.();
    } catch {
      if (current(owner)) {
        refreshError =
          "プロフィールは確認済みです。ホームの表示を更新できませんでした。";
        publish();
      }
    }
  }
  async function read(reset = false): Promise<boolean> {
    if (!live() || !actorId || loading || saving || imageBusy()) return false;
    const resetVersions = reset ? { ...fieldVersions } : undefined;
    const owner = ++generation,
      abort = new AbortController(),
      recovering = uncertain;
    pending = abort;
    loading = true;
    if (options.recovery) recoveryReviewed = false;
    error = "";
    message = "";
    refreshError = "";
    publish();
    if (!current(owner)) return false;
    try {
      const actor = await loadMobileEditableProfile(
        session,
        actorId,
        abort.signal,
      );
      if (!current(owner)) return false;
      const previousBase = base ? profileForm(base) : undefined;
      const firstRecoveryRead = !recoveryLoaded;
      let restoredSaved = false;
      if (firstRecoveryRead) {
        try {
          recoveryPort ??= options.recovery!();
          if (recoveryPort.actorApId !== actorId || recoveryPort.scope.hostUrl !== normalizeHostUrl(session.hostUrl) ||
            recoveryPort.scope.apiBaseUrl !== session.apiBaseUrl || recoveryPort.scope.product !== session.product) throw new Error("保存先の本人・接続先が一致しません。");
          const saved = await recoveryPort.load(); if (!current(owner)) return false;
          restoredSaved = !!saved;
          base = actor; draft = profileForm(actor);
          if (saved) for (const key of profileFormKeys) {
            if (!same(saved.draft[key], saved.base[key])) Object.assign(draft, { [key]: saved.draft[key] });
          }
          if (saved) { attempted = saved.attempted; recoveryReviewBase = copy(saved.base); }
          for (const key of ["icon_url", "header_url"] as const) {
            const image = saved?.images?.[key]; if (!image) continue;
            if (image.phase === "ready" && profileForm(actor)[key] === image.upload.url) {
              uploads[key] = { phase: "ready", name: image.name, saved: true, error: "" };
            } else if (image.phase === "ready" && !(image.upload.expiresAt && Date.parse(image.upload.expiresAt) <= Date.now())) {
              uploaded[key] = { ...image.upload }; uploads[key] = { phase: "ready", name: image.name, error: "" };
            } else uploads[key] = { phase: "reselect", name: image.name, error: "元の画像を再選択するか、画像の選択を取り消してください。" };
          }
          recoveryLoaded = true; recoveryError = "";
        } catch (cause) { if (current(owner)) recoveryError = "保存したプロフィール入力を確認できませんでした。再確認まで保存を待機します。"; throw cause; }
      } else merge(actor, resetVersions);
      loading = false;
      if (options.recovery) {
        const before = recoveryReviewBase ?? previousBase, currentForm = profileForm(actor);
        recoveryConflicts = before ? profileFormKeys.filter(key => !same(draft[key], before[key]) &&
          !same(currentForm[key], before[key]) && !same(currentForm[key], draft[key]) &&
          !(attempted && key in attempted.patch && same(currentForm[key], attempted.patch[key]))) : [];
        if (attempted || recoveryConflicts.length) recoveryReviewBase ??= before && copy(before);
        else recoveryReviewBase = undefined;
        uncertain = !!attempted; needsReload = !!attempted || recoveryConflicts.length > 0; recoveryReviewed = needsReload && !firstRecoveryRead;
      } else { attempted = undefined; needsReload = false; uncertain = false; }
      message = getState().dirty
        ? "現在の保存状態を確認しました。入力中の変更はまだ保存されていません。"
        : "現在の保存状態を確認しました。";
      if (options.recovery && (restoredSaved || reset || getState().dirty || attempted || recoveryReviewBase)) changedRecovery();
      options.onReceipt?.(actor);
      if (!current(owner)) return false;
      publish();
      if (!current(owner)) return false;
      if (recovering) await refresh(owner);
    } catch (cause) {
      if (current(owner)) {
        loading = false;
        needsReload = true;
        error =
          cause instanceof Error
            ? cause.message
            : "プロフィールを確認できませんでした。";
        publish();
      }
    } finally {
      if (pending === abort) pending = undefined;
    }
    return current(owner);
  }
  async function show(id: string) {
    if (disposed || options.isActive?.() === false) return false;
    if (actorId && actorId !== id) return false;
    actorId = id;
    visible = true;
    publish();
    if (!base && !needsReload) return read();
    return live();
  }
  async function save(): Promise<boolean> {
    if (!getState().canSave || !actorId) return false;
    const changes = patch(),
      owner = ++generation,
      abort = new AbortController();
    const submittedImages = (["icon_url", "header_url"] as const).flatMap(key => {
      const receipt = uploaded[key]; return receipt && changes[key] === receipt.url ? [{ key, receipt: { ...receipt } }] : [];
    });
    attempted = { draft: copy(draft), patch: changes };
    pending = abort;
    saving = true;
    uncertain = true;
    error = "";
    message = "";
    refreshError = "";
    publish();
    if (!current(owner)) return false;
    let dispatched = false;
    try {
      if (options.recovery) {
        changedRecovery();
        if (!await flushRecovery()) throw new Error("プロフィール変更前の保存が必要です。");
        if (!current(owner)) return false;
        if (submittedImages.some(({ receipt }) => receipt.expiresAt && Date.parse(receipt.expiresAt) <= Date.now())) {
          for (const { key, receipt } of submittedImages) {
            if (receipt.expiresAt && Date.parse(receipt.expiresAt) <= Date.now() && uploaded[key]?.url === receipt.url) {
              delete uploaded[key]; uploads[key] = { name: receipt.name ?? "画像", phase: files[key] ? "error" : "reselect", error: "画像の有効期限が切れました。再選択してください。" };
            }
          }
          throw new Error("画像の有効期限が切れています。プロフィールは変更していません。");
        }
      }
      dispatched = true;
      const actor = await saveMobileProfile(
        session,
        actorId,
        changes,
        abort.signal,
      );
      if (!current(owner)) return false;
      merge(actor);
      attempted = undefined;
      saving = false;
      uncertain = false;
      needsReload = false;
      message = getState().dirty
        ? "送信した変更は保存済みです。新しい変更はまだ保存されていません。"
        : "プロフィールを保存しました。";
      if (options.recovery) { recoveryReviewBase = undefined; recoveryReviewed = false; changedRecovery(); await flushRecovery(); }
      options.onReceipt?.(actor);
      if (!current(owner)) return false;
      publish();
      if (!current(owner)) return false;
      await refresh(owner);
    } catch (cause) {
      if (current(owner)) {
        saving = false;
        needsReload = dispatched;
        if (!dispatched) { attempted = undefined; uncertain = false; }
        error = dispatched ? `保存結果を確認できませんでした。状態を確認してから操作してください。 ${cause instanceof Error ? cause.message : "通信エラー"}`
          : "プロフィール変更前の安全な保存を確認できませんでした。入力を保持しています。";
        if (options.recovery) { changedRecovery(); if (dispatched || !recoveryError) await flushRecovery(); }
        publish();
      }
    } finally {
      if (pending === abort) pending = undefined;
    }
    return current(owner);
  }
  function setField<K extends keyof MobileProfileForm>(
    key: K,
    value: MobileProfileForm[K],
  ) {
    if (!live() || !base) return;
    if (key === "icon_url" || key === "header_url") {
      const imageKey = key as ImageKey;
      imageVersions[imageKey]++;
      imageReads[imageKey]?.abort();
      delete imageReads[imageKey];
      delete uploads[imageKey];
      delete files[imageKey];
      delete uploaded[imageKey];
    }
    draft = copy({ ...draft, [key]: value });
    fieldVersions[key]++;
    revision++;
    changedRecovery();
    message = "";
    if (!needsReload && !saving && !loading) error = "";
    publish();
  }
  async function pickImage(key: ImageKey, file: File): Promise<boolean> {
    if (!live() || !base || loading || saving) return false;
    imageVersions[key]++;
    imageReads[key]?.abort();
    const owner = generation,
      version = imageVersions[key],
      abort = new AbortController();
    imageReads[key] = abort;
    files[key] = file;
    delete uploaded[key];
    uploads[key] = { name: file.name, phase: "uploading", error: "" };
    changedRecovery();
    publish();
    try {
      if (
        !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          file.type,
        )
      )
        throw Error("JPEG・PNG・GIF・WebPの画像を選択してください。");
      const result = await uploadPostMedia(session, file, abort.signal);
      if (!current(owner) || imageVersions[key] !== version) return false;
      uploaded[key] = result;
      draft = { ...draft, [key]: result.url };
      fieldVersions[key]++;
      revision++;
      changedRecovery();
      message = "";
      uploads[key] = { name: file.name, phase: "ready", error: "" };
      publish();
    } catch (cause) {
      if (current(owner) && imageVersions[key] === version) {
        uploads[key] = {
          name: file.name,
          phase: "error",
          error:
            cause instanceof Error
              ? cause.message
              : "画像をアップロードできませんでした。",
        };
        changedRecovery();
        publish();
      }
    } finally {
      if (imageReads[key] === abort) delete imageReads[key];
    }
    return current(owner) && imageVersions[key] === version;
  }
  async function discard() {
    if (!live() || getState().busy) return false;
    const owner = generation,
      edited = revision;
    let yes = false;
    try {
      yes = (await options.confirmDiscard?.()) ?? false;
    } catch {}
    if (!yes || !current(owner) || revision !== edited || getState().busy)
      return false;
    stopImages();
    for (const key of ["icon_url", "header_url"] as const) {
      delete files[key];
      delete uploaded[key];
      delete uploads[key];
    }
    return read(true);
  }
  function dispose() {
    if (disposed) return;
    if (recoveryLoaded && !recoveryError && savedRecoveryRevision !== recoveryRevision) void flushRecovery();
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    disposed = true;
    generation++;
    pending?.abort();
    stopImages();
    base = null;
    draft = empty();
    for (const key of ["icon_url", "header_url"] as const) {
      delete files[key];
      delete uploaded[key];
    }
    attempted = undefined;
  }
  return {
    getState,
    getActorId: () => actorId,
    show,
    save,
    reload: () => read(),
    close: pause,
    pause,
    dispose,
    setField,
    pickImage,
    restoreImage: (key: ImageKey) => {
      if (base) setField(key, profileForm(base)[key]);
    },
    retryImage: (key: ImageKey) =>
      files[key] ? pickImage(key, files[key]!) : Promise.resolve(false),
    discard,
    flushRecovery,
    confirmRecoveryReview,
  };

  function changedRecovery() {
    recoveryRevision++;
    if (!options.recovery || !recoveryLoaded || recoveryError || disposed) return;
    clearTimeout(recoveryTimer); recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void flushRecovery(); }, 150);
  }
  async function flushRecovery() {
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    if (!options.recovery || disposed) return false;
    if (!recoveryLoaded) { await read(); if (!recoveryLoaded) return false; }
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    if (!base || !recoveryPort) return false;
    recoverySaving++; publish();
    try {
      let revision: number;
      do {
        revision = recoveryRevision;
        const images: NonNullable<ProfileRecoverySnapshot["images"]> = {};
        for (const key of ["icon_url", "header_url"] as const) {
          const view = uploads[key], receipt = uploaded[key]; if (!view || view.saved) continue;
          if (view.phase === "ready" && receipt) images[key] = { phase: "ready", name: view.name, upload: { ...receipt } };
          else images[key] = { phase: "reselect", name: view.name };
        }
        const data: ProfileRecoverySnapshot = { base: copy(!confirmingRecovery && recoveryReviewBase ? recoveryReviewBase : profileForm(base)), draft: copy(draft),
          ...(Object.keys(images).length ? { images } : {}),
          ...(attempted && !confirmingRecovery ? { attempted: { draft: copy(attempted.draft), patch: { ...attempted.patch } } } : {}) };
        await recoveryPort.save(data);
        if (disposed) return false; savedRecoveryRevision = revision;
      } while (recoveryRevision !== revision);
      recoveryError = "";
      return true;
    } catch { if (!disposed) recoveryError = "プロフィール入力の保存を確認できませんでした。保存を再試行してください。"; return false; }
    finally { recoverySaving--; publish(); }
  }
  async function confirmRecoveryReview() {
    if (!getState().recovery?.canConfirmReview || !live()) return;
    const owner = generation; confirmingRecovery = true;
    try {
      if (await flushRecovery() && current(owner)) {
        attempted = undefined; uncertain = false; needsReload = false; recoveryReviewed = false; recoveryReviewBase = undefined; recoveryConflicts = [];
        message = "現在の保存状態と元の変更を確認しました。新しい入力はまだ保存していません。";
      }
    } finally { confirmingRecovery = false; publish(); }
  }
}
