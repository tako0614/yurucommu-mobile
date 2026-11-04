import type { MobileSession } from "@takosjp/mobile-kit";
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
type ImageKey = "icon_url" | "header_url";
interface Upload {
  name: string;
  phase: "uploading" | "ready" | "error";
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
}) {
  const session = snapshotFeedSession(options.session);
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
      canSave:
        live() &&
        !!base &&
        !loading &&
        !saving &&
        !imageBusy() &&
        !Object.values(uploads).some((v) => v?.phase === "error") &&
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
      merge(actor, resetVersions);
      attempted = undefined;
      loading = false;
      needsReload = false;
      uncertain = false;
      message = getState().dirty
        ? "現在の保存状態を確認しました。入力中の変更はまだ保存されていません。"
        : "現在の保存状態を確認しました。";
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
    attempted = { draft: copy(draft), patch: changes };
    pending = abort;
    saving = true;
    uncertain = true;
    error = "";
    message = "";
    refreshError = "";
    publish();
    if (!current(owner)) return false;
    try {
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
      options.onReceipt?.(actor);
      if (!current(owner)) return false;
      publish();
      if (!current(owner)) return false;
      await refresh(owner);
    } catch (cause) {
      if (current(owner)) {
        saving = false;
        needsReload = true;
        error = `保存結果を確認できませんでした。状態を確認してから操作してください。 ${cause instanceof Error ? cause.message : "通信エラー"}`;
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
  };
}
