import type { MobileSession } from "@takosjp/mobile-kit";
import { snapshotFeedSession } from "./feed-session.ts";
import {
  loadMobileProfileFollow,
  setMobileProfileFollow,
  type MobileFollowReceipt,
  type MobileFollowStatus,
} from "./profile-follow-api.ts";
export interface ProfileFollowState {
  readonly actorId: string;
  readonly status: MobileFollowStatus | null;
  readonly isSelf: boolean | null;
  readonly busy: boolean;
  readonly needsReload: boolean;
  readonly uncertain: boolean;
  readonly error: string;
  readonly message: string;
  readonly refreshError: string;
  readonly canChange: boolean;
}
export function createProfileFollowController(options: {
  session: MobileSession;
  actorId: string;
  isActive?: () => boolean;
  onChange?: () => void;
  onReceipt?: (receipt: MobileFollowReceipt) => void;
  onConfirmed?: () => Promise<void>;
}) {
  const session = snapshotFeedSession(options.session),
    id = options.actorId;
  let disposed = false,
    visible = false,
    generation = 0,
    pending: AbortController | undefined;
  let state = {
    actorId: id,
    status: null as MobileFollowStatus | null,
    isSelf: null as boolean | null,
    busy: false,
    needsReload: false,
    uncertain: false,
    error: "",
    message: "",
    refreshError: "",
  };
  const live = () => !disposed && visible && options.isActive?.() !== false;
  const current = (owner: number) => live() && owner === generation;
  const getState = (): ProfileFollowState => ({
    ...state,
    canChange:
      live() &&
      !state.busy &&
      !state.needsReload &&
      state.status !== null &&
      state.isSelf === false,
  });
  const publish = () => {
    if (!disposed) options.onChange?.();
  };
  function pause() {
    generation++;
    pending?.abort();
    pending = undefined;
    if (state.busy)
      state = {
        ...state,
        busy: false,
        needsReload: true,
        error: state.uncertain
          ? "フォローの結果が不明です。状態を確認してください。"
          : "フォロー状態の確認を中断しました。",
        message: "",
        refreshError: "",
      };
    publish();
  }
  async function change(readOnly: boolean): Promise<boolean> {
    if (!live() || state.busy || (!readOnly && !getState().canChange))
      return false;
    const owner = ++generation,
      abort = new AbortController(),
      wasUncertain = state.uncertain,
      previous = state.status,
      wantsFollow = state.status === "none";
    pending = abort;
    state = {
      ...state,
      busy: true,
      uncertain: state.uncertain || !readOnly,
      error: "",
      message: "",
      refreshError: "",
    };
    publish();
    if (!current(owner)) return false;
    try {
      const receipt = readOnly
        ? await loadMobileProfileFollow(session, id, abort.signal)
        : await setMobileProfileFollow(session, id, wantsFollow, abort.signal);
      if (!current(owner)) return false;
      state = {
        ...state,
        status: receipt.status,
        isSelf: receipt.isSelf,
        busy: false,
        needsReload: receipt.status === null && !receipt.isSelf,
        uncertain: false,
        error:
          receipt.status === null && !receipt.isSelf
            ? "サーバーからフォロー状態を確認できませんでした。"
            : "",
        message: readOnly
          ? "フォロー状態を確認しました。"
          : receipt.status === "pending"
            ? "フォローを申請しました。"
            : receipt.status === "accepted"
              ? "フォローしました。"
              : previous === "pending"
                ? "申請を取り消しました。"
                : "フォローを解除しました。",
      };
      options.onReceipt?.(receipt);
      if (!current(owner)) return false;
      publish();
      if (!current(owner)) return false;
      if (!readOnly || wasUncertain) {
        try {
          await options.onConfirmed?.();
        } catch {
          if (current(owner)) {
            state = {
              ...state,
              refreshError:
                "関係は確認済みです。ホームの件数を更新できませんでした。",
            };
            publish();
          }
        }
      }
    } catch (cause) {
      if (current(owner)) {
        state = {
          ...state,
          busy: false,
          needsReload: true,
          error: `フォローの結果を確認できませんでした。状態を確認してから操作してください。 ${cause instanceof Error ? cause.message : "通信エラー"}`,
          message: "",
        };
        publish();
      }
    } finally {
      if (pending === abort) pending = undefined;
    }
    return current(owner);
  }
  function setActive(value: boolean) {
    if (disposed || value === visible) return;
    visible = value;
    if (!value) pause();
    else {
      publish();
      if (!state.needsReload) void change(true);
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
    setActive,
    pause,
    dispose,
    reload: () => change(true),
    change: () => change(false),
  };
}
