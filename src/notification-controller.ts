import {
  appendUniqueMobileItemsById,
  type MobileSession,
} from "@takosjp/mobile-kit";
import type { Notification } from "@takosjp/yurucommu-api";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";
import { setMobilePostBookmark } from "./api.ts";
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
  readonly bookmarkBusy: boolean;
  readonly bookmarkError: string;
  readonly bookmarkNeedsReload: boolean;
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
  bookmarkBusy: false,
  bookmarkError: "",
  bookmarkNeedsReload: false,
});

// Owns one mounted app view, independently of the shared shell's credentials.
// Every response must still belong to this account incarnation and navigation.
export function createNotificationController(options: {
  session: MobileSession;
  onChange?: (state: NotificationState) => void;
  isActive?: () => boolean;
  onBookmarksChanged?: () => void;
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
  let activeRead: AbortController | undefined;
  let activeBookmark: AbortController | undefined;
  function cancelBookmark() {
    activeBookmark?.abort();
    activeBookmark = undefined;
  }
  function startRead() {
    cancelBookmark();
    activeRead?.abort();
    const read = new AbortController();
    activeRead = read;
    return read;
  }
  function cancelRead() {
    cancelBookmark();
    activeRead?.abort();
    activeRead = undefined;
  }
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
    cancelRead();
    postId = undefined;
    failedContinuation = false;
    state = initial();
    options.onChange?.(state);
  }

  async function openNotifications() {
    if (!live()) return;
    const owner = authority,
      generation = ++request;
    const read = startRead();
    failedContinuation = false;
    postId = undefined;
    publish({ ...initial(), page: "notifications", loading: true });
    try {
      const page = await loadMobileNotifications(
        session,
        undefined,
        read.signal,
      );
      if (!current(owner, generation)) return;
      publish({ ...state, ...page, loading: false, listLoaded: true });
    } catch (error) {
      if (current(owner, generation))
        publish({ ...state, loading: false, error: message(error) });
    } finally {
      if (activeRead === read) activeRead = undefined;
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
    const read = startRead();
    failedContinuation = false;
    publish({ ...state, loadingMore: true, error: "" });
    try {
      const page = await loadMobileNotifications(session, cursor, read.signal);
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
    } finally {
      if (activeRead === read) activeRead = undefined;
    }
  }

  async function openPost(id: string) {
    if (!live()) return;
    const owner = authority,
      generation = ++request;
    const read = startRead();
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
      bookmarkBusy: false,
      bookmarkError: "",
      bookmarkNeedsReload: false,
    });
    try {
      const post = await loadMobileNotificationPost(session, id, read.signal);
      if (current(owner, generation))
        publish({ ...state, post, loading: false });
    } catch (error) {
      if (current(owner, generation))
        publish({ ...state, loading: false, error: message(error) });
    } finally {
      if (activeRead === read) activeRead = undefined;
    }
  }

  function showHome() {
    if (!live()) return;
    request++;
    cancelRead();
    postId = undefined;
    failedContinuation = false;
    publish({
      ...state,
      page: "home",
      loading: false,
      loadingMore: false,
      error: "",
      post: undefined,
      bookmarkBusy: false,
      bookmarkError: "",
      bookmarkNeedsReload: false,
    });
  }

  function back(): Promise<void> | void {
    if (!live()) return;
    if (state.page !== "post" || postBack !== "notifications")
      return showHome();
    if (!state.listLoaded) return openNotifications();
    request++;
    cancelRead();
    postId = undefined;
    publish({
      ...state,
      page: "notifications",
      post: undefined,
      loading: false,
      loadingMore: false,
      error: "",
      bookmarkBusy: false,
      bookmarkError: "",
      bookmarkNeedsReload: false,
    });
  }

  function reload(): Promise<void> | void {
    if (!live() || state.loading || state.loadingMore || state.bookmarkBusy)
      return;
    if (state.page === "notifications") return openNotifications();
    if (state.page === "post" && postId) return openPost(postId);
  }

  function retry(): Promise<void> | void {
    if (!live() || state.loading || state.loadingMore || state.bookmarkBusy)
      return;
    if (state.page === "notifications" && failedContinuation) return loadMore();
    return reload();
  }

  async function toggleBookmark() {
    if (
      !live() ||
      state.page !== "post" ||
      !state.post ||
      !postId ||
      state.post.bookmarkState === null ||
      state.bookmarkBusy ||
      state.bookmarkNeedsReload ||
      state.loading
    )
      return;
    const owner = authority,
      generation = request,
      id = postId;
    const target = !state.post.bookmarkState;
    const write = new AbortController();
    activeBookmark = write;
    publish({ ...state, bookmarkBusy: true, bookmarkError: "" });
    try {
      await setMobilePostBookmark(session, id, target, write.signal);
      if (current(owner, generation) && state.post) {
        publish({
          ...state,
          post: { ...state.post, bookmarked: target, bookmarkState: target },
          bookmarkBusy: false,
        });
      }
    } catch (error) {
      if (current(owner, generation))
        publish({
          ...state,
          bookmarkBusy: false,
          bookmarkNeedsReload: true,
          bookmarkError: `保存結果を確認できませんでした。再読み込みで状態を確認してください。 ${message(error)}`,
        });
    } finally {
      if (activeBookmark === write) activeBookmark = undefined;
      // Re-read the actual saved preview, even if this account navigated back
      // while the result was unknown. Never infer a list edit from a failed ACK.
      if (live() && authority === owner) options.onBookmarksChanged?.();
    }
  }

  function dispose() {
    disposed = true;
    cancelRead();
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
    toggleBookmark,
    dispose,
  };
}
