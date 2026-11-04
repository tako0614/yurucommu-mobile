import {
  appendUniqueMobileItemsById,
  type MobileSession,
} from "@takosjp/mobile-kit";
import type { Notification } from "@takosjp/yurucommu-api";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";
import {
  loadMobileNotificationPost,
  loadMobileNotifications,
  type MobileNotificationPost,
} from "./notification-api.ts";

export type NotificationPage = "home" | "notifications" | "post";
export interface NotificationState {
  readonly page: NotificationPage;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string;
  readonly notifications: readonly Notification[];
  readonly listLoaded: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly post?: MobileNotificationPost;
}
const initial = (): NotificationState => ({
  page: "home",
  loading: false,
  loadingMore: false,
  error: "",
  notifications: [],
  listLoaded: false,
  hasMore: false,
  nextCursor: null,
});

// Owns one mounted app view, independently of the shared shell's credentials.
// Every response must still belong to this account incarnation and navigation.
export function createNotificationController(options: {
  session: MobileSession;
  onChange?: (state: NotificationState) => void;
  isActive?: () => boolean;
}) {
  let session = snapshotFeedSession(options.session);
  let sessionKey = feedSessionIdentity(session);
  let authority = 0,
    request = 0;
  let disposed = false;
  let state = initial();
  let postId: string | undefined;
  let postBack: NotificationPage = "home";
  let failedContinuation = false;
  const live = () => !disposed && options.isActive?.() !== false;
  const current = (owner: number, generation: number) =>
    live() && authority === owner && request === generation;
  const publish = (next: NotificationState) => {
    state = next;
    if (live()) options.onChange?.(state);
  };
  const message = (error: unknown) =>
    error instanceof Error
      ? error.message
      : "読み込めませんでした。再試行してください。";

  function updateSession(next: MobileSession) {
    const key = feedSessionIdentity(next);
    if (disposed || key === sessionKey) return;
    session = snapshotFeedSession(next);
    sessionKey = key;
    authority++;
    request++;
    postId = undefined;
    failedContinuation = false;
    state = initial();
    options.onChange?.(state);
  }

  async function openNotifications() {
    if (!live()) return;
    const owner = authority,
      generation = ++request;
    failedContinuation = false;
    postId = undefined;
    publish({ ...initial(), page: "notifications", loading: true });
    try {
      const page = await loadMobileNotifications(session);
      if (!current(owner, generation)) return;
      publish({ ...state, ...page, loading: false, listLoaded: true });
    } catch (error) {
      if (current(owner, generation))
        publish({ ...state, loading: false, error: message(error) });
    }
  }

  async function loadMore() {
    if (
      !live() ||
      state.page !== "notifications" ||
      state.loading ||
      state.loadingMore ||
      !state.hasMore ||
      !state.nextCursor
    )
      return;
    const owner = authority,
      generation = request,
      cursor = state.nextCursor;
    failedContinuation = false;
    publish({ ...state, loadingMore: true, error: "" });
    try {
      const page = await loadMobileNotifications(session, cursor);
      if (!current(owner, generation)) return;
      if (page.hasMore && page.nextCursor === cursor)
        throw new Error(
          "通知の続きの位置が更新されませんでした。再読み込みしてください。",
        );
      publish({
        ...state,
        ...page,
        loadingMore: false,
        notifications: appendUniqueMobileItemsById(
          state.notifications,
          page.notifications,
        ),
      });
    } catch (error) {
      if (current(owner, generation)) {
        failedContinuation = true;
        publish({ ...state, loadingMore: false, error: message(error) });
      }
    }
  }

  async function openPost(id: string) {
    if (!live()) return;
    const owner = authority,
      generation = ++request;
    failedContinuation = false;
    if (state.page !== "post") postBack = state.page;
    postId = id;
    publish({
      ...state,
      page: "post",
      post: undefined,
      loading: true,
      loadingMore: false,
      error: "",
    });
    try {
      const post = await loadMobileNotificationPost(session, id);
      if (current(owner, generation))
        publish({ ...state, post, loading: false });
    } catch (error) {
      if (current(owner, generation))
        publish({ ...state, loading: false, error: message(error) });
    }
  }

  function showHome() {
    if (!live()) return;
    request++;
    postId = undefined;
    failedContinuation = false;
    publish({
      ...state,
      page: "home",
      loading: false,
      loadingMore: false,
      error: "",
      post: undefined,
    });
  }

  function back(): Promise<void> | void {
    if (!live()) return;
    if (state.page !== "post" || postBack !== "notifications")
      return showHome();
    if (!state.listLoaded) return openNotifications();
    request++;
    postId = undefined;
    publish({
      ...state,
      page: "notifications",
      post: undefined,
      loading: false,
      loadingMore: false,
      error: "",
    });
  }

  function reload(): Promise<void> | void {
    if (!live() || state.loading || state.loadingMore) return;
    if (state.page === "notifications") return openNotifications();
    if (state.page === "post" && postId) return openPost(postId);
  }

  function retry(): Promise<void> | void {
    if (!live() || state.loading || state.loadingMore) return;
    if (state.page === "notifications" && failedContinuation) return loadMore();
    return reload();
  }

  function dispose() {
    disposed = true;
    authority++;
    request++;
    failedContinuation = false;
    state = initial();
  }
  return {
    getState: () => state,
    updateSession,
    openNotifications,
    loadMore,
    openPost,
    showHome,
    back,
    retry,
    reload,
    dispose,
  };
}
