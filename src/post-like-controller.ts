import type { MobileSession } from "@takosjp/mobile-kit";
import {
  loadMobilePostLike,
  setMobilePostLike,
  type MobilePostLikeReceipt,
  mobilePostLikeReadStartedAt,
} from "./api.ts";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";

export interface MobileLikePost {
  readonly ap_id: string;
  readonly like_count: number;
  readonly likeState?: boolean | null;
}
export interface MobileLikeState {
  readonly apId: string;
  readonly count: number;
  readonly liked: boolean | null;
  readonly busy: boolean;
  readonly needsReload: boolean;
  readonly error: string;
  readonly status: string;
  readonly refreshError: string;
  readonly canToggle: boolean;
}
const scopeKey = (session: MobileSession) =>
  JSON.stringify([feedSessionIdentity(session), session.apiBaseUrl]);

export function createPostLikeController(options: {
  session: MobileSession;
  post: MobileLikePost;
  isActive?: () => boolean;
  onChange?: (state: MobileLikeState) => void;
  onChanged?: () => Promise<void>;
}) {
  let session = snapshotFeedSession(options.session),
    key = scopeKey(session);
  let source = options.post;
  let disposed = false,
    visible = options.isActive?.() !== false,
    generation = 0;
  let pending: AbortController | undefined;
  let readFence = -Infinity;
  let state = fromPost(source);
  function fromPost(post: MobileLikePost) {
    const countValid =
      Number.isSafeInteger(post.like_count) && post.like_count >= 0;
    return {
      apId: post.ap_id,
      count: countValid ? post.like_count : 0,
      liked:
        countValid && typeof post.likeState === "boolean"
          ? post.likeState
          : null,
      busy: false,
      needsReload: false,
      error: "",
      status: "",
      refreshError: "",
    };
  }
  const live = () => !disposed && visible && options.isActive?.() !== false;
  const current = (owner: number) => live() && generation === owner;
  const getState = (): MobileLikeState => ({
    ...state,
    canToggle:
      live() && !state.busy && !state.needsReload && state.liked !== null,
  });
  const publish = () => {
    if (!disposed) options.onChange?.(getState());
  };
  function pause() {
    if (state.busy) readFence = performance.now();
    generation++;
    pending?.abort();
    pending = undefined;
    if (state.busy)
      state = {
        ...state,
        busy: false,
        needsReload: true,
        error:
          "操作結果が不明です。いいねの状態を確認してから操作してください。",
        status: "",
        refreshError: "",
      };
    publish();
  }
  function setActive(value: boolean) {
    if (value === visible || disposed) return;
    visible = value;
    if (!value) pause();
    else publish();
  }
  function updateSession(value: MobileSession) {
    if (disposed) return;
    const next = snapshotFeedSession(value),
      nextKey = scopeKey(next);
    session = next;
    if (nextKey === key) return;
    key = nextKey;
    readFence = -Infinity;
    generation++;
    pending?.abort();
    pending = undefined;
    // The previous viewer flag is not authority in the new account/API scope.
    state = { ...fromPost(source), liked: null };
    publish();
  }
  function updatePost(value: MobileLikePost) {
    if (disposed || value === source) return;
    const different = value.ap_id !== state.apId;
    source = value;
    if (different) {
      generation++;
      pending?.abort();
      pending = undefined;
      state = fromPost(value);
    } else if (!state.busy && !state.needsReload) state = fromPost(value);
    publish();
  }
  async function change(readOnly: boolean) {
    if (
      !live() ||
      state.busy ||
      !state.apId.trim() ||
      (!readOnly && !getState().canToggle)
    )
      return;
    readFence = performance.now();
    const owner = ++generation,
      id = state.apId,
      target = !state.liked;
    const selected = snapshotFeedSession(session),
      abort = new AbortController();
    pending = abort;
    state = { ...state, busy: true, error: "", status: "", refreshError: "" };
    publish();
    try {
      const receipt: MobilePostLikeReceipt = readOnly
        ? await loadMobilePostLike(selected, id, abort.signal)
        : await setMobilePostLike(selected, id, target, abort.signal);
      if (!current(owner)) return;
      readFence = performance.now();
      state = {
        ...state,
        count: receipt.like_count,
        liked: receipt.likeState,
        busy: false,
        needsReload: false,
        status: readOnly
          ? "いいねの状態を確認しました。"
          : target
            ? "いいねを反映しました。"
            : "いいねを取り消しました。",
      };
      publish();
      if (!current(owner)) return;
      try {
        await options.onChanged?.();
      } catch {
        if (current(owner)) {
          state = {
            ...state,
            refreshError:
              "いいねは確認済みです。フィードを更新できませんでした。",
          };
          publish();
        }
      }
    } catch (cause) {
      if (!current(owner)) return;
      readFence = performance.now();
      state = {
        ...state,
        busy: false,
        needsReload: true,
        status: "",
        error: `いいねの結果を確認できませんでした。状態を確認してから操作してください。 ${cause instanceof Error ? cause.message : "通信エラー"}`,
      };
      publish();
    } finally {
      if (pending === abort) pending = undefined;
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    pending?.abort();
    pending = undefined;
  }
  return {
    getState,
    getReadFence: () => readFence,
    setActive,
    updateSession,
    updatePost,
    pause,
    toggle: () => change(false),
    reload: () => change(true),
    dispose,
  };
}

/** One account/view owns one operation and recovery state per AP ID. */
export function createPostLikeStore(options: {
  session: MobileSession;
  isActive?: () => boolean;
}) {
  let session = snapshotFeedSession(options.session),
    key = scopeKey(session),
    disposed = false;
  type Owner = { active: boolean; notify: (state: MobileLikeState) => void };
  type Entry = {
    controller: ReturnType<typeof createPostLikeController>;
    owners: Set<Owner>;
  };
  const entries = new Map<string, Entry>();
  function makeController(post: MobileLikePost, owners: Set<Owner>) {
    const ownerKey = key;
    return createPostLikeController({
      session,
      post,
      isActive: () => !disposed && options.isActive?.() !== false,
      onChange: (state) => {
        for (const owner of owners) {
          if (disposed || key !== ownerKey) return;
          owner.notify(state);
        }
      },
    });
  }
  function acquire(
    post: MobileLikePost,
    notify: (state: MobileLikeState) => void,
  ) {
    if (disposed) throw new Error("いいねの表示先は終了しています。");
    const postId = post.ap_id;
    let entry = entries.get(postId);
    if (!entry) {
      const owners = new Set<Owner>(),
        valid = mobilePostLikeReadStartedAt(post, session) !== null;
      entry = {
        controller: makeController(
          valid
            ? post
            : { ap_id: postId, like_count: post.like_count, likeState: null },
          owners,
        ),
        owners,
      };
      entries.set(postId, entry);
    }
    const value = entry,
      owner: Owner = { active: false, notify };
    let released = false;
    value.owners.add(owner);
    const updateVisibility = () =>
      value.controller.setActive(
        Array.from(value.owners).some((o) => o.active),
      );
    const adopt = (next: MobileLikePost) => {
      if (released || next.ap_id !== postId) return;
      const startedAt = mobilePostLikeReadStartedAt(next, session);
      if (
        startedAt !== null &&
        startedAt > value.controller.getReadFence() &&
        !value.controller.getState().needsReload
      )
        value.controller.updatePost(next);
    };
    adopt(post);
    updateVisibility();
    notify(value.controller.getState());
    return {
      apId: postId,
      getState: () => value.controller.getState(),
      updatePost: adopt,
      setActive: (active: boolean) => {
        if (!released) {
          owner.active = active;
          updateVisibility();
          notify(value.controller.getState());
        }
      },
      toggle: () =>
        !released && owner.active
          ? value.controller.toggle()
          : Promise.resolve(),
      reload: () =>
        !released && owner.active
          ? value.controller.reload()
          : Promise.resolve(),
      dispose: () => {
        if (released) return;
        released = true;
        value.owners.delete(owner);
        updateVisibility();
      },
    };
  }
  function updateSession(next: MobileSession) {
    if (disposed) return;
    session = snapshotFeedSession(next);
    const nextKey = scopeKey(next);
    if (nextKey === key) return;
    key = nextKey;
    // Drop old controllers and their source references, not just viewer flags.
    // Existing mounted owners rebind to a blank controller for the new scope.
    for (const [id, entry] of entries) {
      entry.controller.dispose();
      entry.controller = makeController(
        { ap_id: id, like_count: 0, likeState: null },
        entry.owners,
      );
      entry.controller.setActive(
        Array.from(entry.owners).some((o) => o.active),
      );
      for (const owner of entry.owners)
        owner.notify(entry.controller.getState());
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of entries.values()) entry.controller.dispose();
    entries.clear();
  }
  return { acquire, updateSession, dispose };
}
export type PostLikeStore = ReturnType<typeof createPostLikeStore>;
