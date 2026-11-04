import {
  appendUniqueMobileItemsById,
  type MobileSession,
} from "@takosjp/mobile-kit";
import type { Notification } from "@takosjp/yurucommu-api";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";
import { deleteMobileOwnPost, MobilePostDeleteError } from "./post-delete-api.ts";
import { setMobilePostBookmark } from "./api.ts";
import { createFeedController, type FeedState } from "./feed-controller.ts";
import {
  loadMobileNotificationPost,
  loadMobileNotifications,
  loadMobilePostReplies,
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
  readonly postDeleteBusy: boolean;
  readonly postDeleteError: string;
  readonly postDeleteNeedsReload: boolean;
  readonly postDeleteStatus: string;
  readonly bookmarkBusy: boolean;
  readonly bookmarkError: string;
  readonly bookmarkNeedsReload: boolean;
  readonly replies: readonly MobileNotificationPost[];
  readonly repliesLoaded: boolean;
  readonly repliesLoading: boolean;
  readonly repliesLoadingMore: boolean;
  readonly repliesError: string;
  readonly repliesHasMore: boolean;
  readonly repliesCursor: string | null;
  readonly replyDraft?: FeedState;
}
const emptyReplies = () => ({
  replies: [] as readonly MobileNotificationPost[],
  repliesLoaded: false,
  repliesLoading: false,
  repliesLoadingMore: false,
  repliesError: "",
  repliesHasMore: false,
  repliesCursor: null as string | null,
});
const emptyPostDelete = () => ({
  postDeleteBusy: false,
  postDeleteError: "",
  postDeleteNeedsReload: false,
  postDeleteStatus: "",
});
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
  ...emptyPostDelete(),
  ...emptyReplies(),
});

// Owns one mounted app view, independently of the shared shell's credentials.
// Every response must still belong to this account incarnation and navigation.
export function createNotificationController(options: {
  session: MobileSession;
  onChange?: (state: NotificationState) => void;
  isActive?: () => boolean;
  onBookmarksChanged?: () => void;
  onPostReplied?: () => Promise<void>;
  getActorId?: () => string | undefined;
  confirmDeletePost?: () => boolean | Promise<boolean>;
  onPostDeleted?: () => Promise<void>;
  confirmDiscardReply?: () => boolean | Promise<boolean>;
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
  let activeDelete: AbortController | undefined;
  let activeReplies: AbortController | undefined;
  let failedRepliesContinuation = false;
  let replyId: string | undefined;
  let replyComposer: ReturnType<typeof createFeedController> | undefined;
  let postHistory: {
    id: string;
    replies: ReturnType<typeof emptyReplies>;
    cursors: string[];
  }[] = [];
  let replyCursors = new Set<string>();
  function cancelReplies() {
    activeReplies?.abort();
    activeReplies = undefined;
  }
  function pauseReply() {
    replyComposer?.pause();
  }
  function cancelBookmark() {
    activeBookmark?.abort();
    activeBookmark = undefined;
  }
  function cancelDelete() {
    activeDelete?.abort();
    activeDelete = undefined;
  }
  function startRead() {
    cancelDelete();
    cancelBookmark();
    cancelReplies();
    pauseReply();
    activeRead?.abort();
    const read = new AbortController();
    activeRead = read;
    return read;
  }
  function cancelRead() {
    cancelDelete();
    cancelBookmark();
    cancelReplies();
    pauseReply();
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
    replyComposer?.dispose();
    replyComposer = undefined;
    replyId = undefined;
    postHistory = [];
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
    postHistory = [];
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

  function ensureReply(post: MobileNotificationPost, id: string) {
    if (!post.replyContext) return;
    const target = { apId: id, ...post.replyContext };
    if (!replyComposer) {
      replyId = id;
      replyComposer = createFeedController({
        session,
        replyTo: target,
        isActive: () =>
          live() &&
          state.page === "post" &&
          postId === id &&
          !!state.post?.replyContext &&
          !state.postDeleteBusy && !state.postDeleteNeedsReload,
        onChange: (draft) => {
          if (live() && state.page === "post" && postId === id)
            publish({ ...state, replyDraft: draft });
        },
        refreshHome: async () => {
          if (!live() || postId !== id || state.page !== "post") return;
          const ok = await readReplies(false);
          if (options.onPostReplied) await options.onPostReplied();
          if (!ok) throw new Error("返信一覧を更新できませんでした。");
        },
      });
    } else replyComposer.updateReplyContext(target);
  }

  async function readReplies(more: boolean): Promise<boolean> {
    if (
      !live() ||
      state.page !== "post" ||
      !state.post ||
      !postId ||
      (more && (state.repliesLoading || state.repliesLoadingMore)) ||
      (more && (!state.repliesHasMore || !state.repliesCursor))
    )
      return false;
    if (!more) {
      cancelReplies();
      replyCursors = new Set();
    }
    const owner = authority,
      generation = request,
      id = postId,
      cursor = more ? state.repliesCursor! : undefined;
    const read = new AbortController();
    activeReplies = read;
    failedRepliesContinuation = false;
    publish({
      ...state,
      repliesLoading: !more,
      repliesLoadingMore: more,
      repliesError: "",
    });
    try {
      const page = await loadMobilePostReplies(
        session,
        id,
        cursor,
        read.signal,
      );
      if (!current(owner, generation) || activeReplies !== read) return false;
      if (
        page.hasMore &&
        page.nextCursor &&
        (page.nextCursor === cursor || replyCursors.has(page.nextCursor))
      )
        throw new Error(
          "返信の続きの位置が更新されませんでした。再読み込みしてください。",
        );
      if (page.nextCursor) replyCursors.add(page.nextCursor);
      const previous = more ? state.replies : [];
      const seen = new Set(previous.map((post) => post.ap_id));
      const replies = [...previous];
      for (const post of page.replies)
        if (!seen.has(post.ap_id)) {
          seen.add(post.ap_id);
          replies.push(post);
        }
      publish({
        ...state,
        replies,
        repliesLoaded: true,
        repliesLoading: false,
        repliesLoadingMore: false,
        repliesHasMore: page.hasMore,
        repliesCursor: page.nextCursor,
      });
      return true;
    } catch (error) {
      if (current(owner, generation) && activeReplies === read) {
        failedRepliesContinuation = more;
        publish({
          ...state,
          repliesLoading: false,
          repliesLoadingMore: false,
          repliesError: message(error),
        });
      }
      return false;
    } finally {
      if (activeReplies === read) activeReplies = undefined;
    }
  }

  async function navigatePost(
    id: string,
    mode: "external" | "reply" | "back" | "reload",
  ) {
    if (!live()) return;
    const beforeOwner = authority,
      beforeRequest = request;
    if (replyComposer && replyId !== id) {
      const draft = replyComposer.getState();
      if (draft.content.length || draft.attachments.length || draft.sending) {
        let discard = false;
        try {
          discard = (await options.confirmDiscardReply?.()) ?? false;
        } catch {
          return;
        }
        if (!current(beforeOwner, beforeRequest) || !discard) return;
      }
      replyComposer.dispose();
      replyComposer = undefined;
      replyId = undefined;
    }
    const restoreEntry =
      mode === "back" ? postHistory[postHistory.length - 1] : undefined;
    const restored = restoreEntry?.replies;
    if (mode === "external") postHistory = [];
    if (mode === "reply" && postId && postId !== id)
      postHistory = [
        ...postHistory,
        {
          id: postId,
          cursors: [...replyCursors],
          replies: {
            replies: state.replies,
            repliesLoaded: state.repliesLoaded,
            repliesHasMore: state.repliesHasMore,
            repliesCursor: state.repliesCursor,
            repliesLoading: false,
            repliesLoadingMore: false,
            repliesError: state.repliesError,
          },
        },
      ].slice(-32);
    if (mode === "back") postHistory.pop();
    replyCursors = new Set(restoreEntry?.cursors ?? []);
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
      ...emptyPostDelete(),
      ...emptyReplies(),
      replyDraft: undefined,
    });
    try {
      const post = await loadMobileNotificationPost(session, id, read.signal);
      if (current(owner, generation)) {
        ensureReply(post, id);
        publish({
          ...state,
          ...(restored ?? {}),
          post,
          loading: false,
          replyDraft: post.replyContext ? replyComposer?.getState() : undefined,
        });
        // The view starts its independently retryable conversation read. Its
        // read capability does not depend on having enough metadata to compose.
      }
    } catch (error) {
      if (current(owner, generation))
        publish({ ...state, loading: false, error: message(error) });
    } finally {
      if (activeRead === read) activeRead = undefined;
    }
  }

  async function openPost(id: string) {
    await navigatePost(id, "external");
  }
  async function openReply(id: string) {
    await navigatePost(id, "reply");
  }

  function showHome() {
    if (!live()) return;
    request++;
    cancelRead();
    postHistory = [];
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
      ...emptyPostDelete(),
      ...emptyReplies(),
      replyDraft: undefined,
    });
  }

  function back(): Promise<void> | void {
    if (!live()) return;
    if (state.page === "post" && postHistory.length)
      return navigatePost(postHistory[postHistory.length - 1]!.id, "back");
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
      ...emptyPostDelete(),
      ...emptyReplies(),
      replyDraft: undefined,
    });
  }

  function reload(): Promise<void> | void {
    if (!live() || state.loading || state.loadingMore || state.bookmarkBusy || state.postDeleteBusy)
      return;
    if (state.page === "notifications") return openNotifications();
    if (state.page === "post" && postId) return navigatePost(postId, "reload");
  }

  function retry(): Promise<void> | void {
    if (!live() || state.loading || state.loadingMore || state.bookmarkBusy || state.postDeleteBusy)
      return;
    if (state.page === "notifications" && failedContinuation) return loadMore();
    return reload();
  }

  function ownsCurrentPost(): boolean {
    const actor = options.getActorId?.();
    return live() && state.page === "post" && !!actor &&
      actor === state.post?.author.ap_id;
  }
  function hasReplyDraft(): boolean {
    const draft = replyComposer?.getState();
    return !!draft && (
      !!draft.content.length || !!draft.attachments.length || draft.sending
    );
  }
  function canDeletePost(): boolean {
    return ownsCurrentPost() && !state.loading && !state.bookmarkBusy &&
      !state.bookmarkNeedsReload && !state.postDeleteBusy &&
      !state.postDeleteNeedsReload && !hasReplyDraft();
  }
  async function deleteOwnPost() {
    if (!canDeletePost() || !state.post || !postId) return;
    const owner = authority;
    const id = postId;
    const post = state.post;
    let generation = request;
    const abort = new AbortController();
    activeDelete = abort;
    publish({ ...state, postDeleteBusy: true, postDeleteError: "", postDeleteStatus: "" });
    try {
      const confirmed = (await options.confirmDeletePost?.()) ?? false;
      if (!confirmed || !current(owner, generation) || abort.signal.aborted || hasReplyDraft())
        return;
      generation = ++request;
      cancelBookmark();
      cancelReplies();
      pauseReply();
      activeRead?.abort();
      activeRead = undefined;
      publish({ ...state, repliesLoading: false, repliesLoadingMore: false });
      await deleteMobileOwnPost(session, id, post.author.ap_id, abort.signal);
      if (!current(owner, generation) || abort.signal.aborted) return;
      activeDelete = undefined;
      replyComposer?.dispose();
      replyComposer = undefined;
      replyId = undefined;
      postHistory = postHistory.filter((entry) => entry.id !== id);
      const returning = back();
      const refreshGeneration = request;
      await returning;
      if (!current(owner, refreshGeneration)) return;
      let notice = "投稿を削除しました。";
      try {
        await options.onPostDeleted?.();
      } catch {
        notice = "投稿は削除済みです。一覧を更新できませんでした。再読み込みで確認してください。";
      }
      if (current(owner, refreshGeneration))
        publish({ ...state, postDeleteStatus: notice });
    } catch (cause) {
      if (current(owner, generation) && !abort.signal.aborted) {
        publish({
          ...state,
          postDeleteNeedsReload: true,
          postDeleteError:
            cause instanceof MobilePostDeleteError && cause.outcome === "not_applied"
              ? `${message(cause)} 投稿を再読み込みして確認してください。`
              : `削除の結果が不明です。再読み込みで確認するまで再送していません。 ${message(cause)}`,
        });
      }
    } finally {
      if (activeDelete === abort) {
        activeDelete = undefined;
        if (current(owner, generation)) publish({ ...state, postDeleteBusy: false });
      }
    }
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
      state.postDeleteBusy || state.postDeleteNeedsReload ||
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

  // An in-app profile can cover this view without deleting its post or drafts.
  function pause() {
    if (disposed) return;
    const reading = state.loading || state.loadingMore;
    const readingReplies = state.repliesLoading || state.repliesLoadingMore;
    const writingBookmark = state.bookmarkBusy;
    const deletingPost = state.postDeleteBusy;
    if (state.loadingMore) failedContinuation = true;
    else if (state.loading) failedContinuation = false;
    if (state.repliesLoadingMore) failedRepliesContinuation = true;
    else if (state.repliesLoading) failedRepliesContinuation = false;
    request++;
    cancelRead();
    publish({
      ...state,
      loading: false,
      loadingMore: false,
      error: reading
        ? "読み込みを中断しました。再試行してください。"
        : state.error,
      postDeleteBusy: false,
      postDeleteNeedsReload: state.postDeleteNeedsReload || deletingPost,
      postDeleteError: deletingPost ? "削除結果が不明です。再読み込みで確認してください。" : state.postDeleteError,
      bookmarkBusy: false,
      bookmarkNeedsReload: state.bookmarkNeedsReload || writingBookmark,
      bookmarkError: writingBookmark
        ? "保存結果が不明です。再読み込みで確認してください。"
        : state.bookmarkError,
      repliesLoading: false,
      repliesLoadingMore: false,
      repliesError: readingReplies
        ? "返信の読み込みを中断しました。再試行してください。"
        : state.repliesError,
      replyDraft: state.post?.replyContext
        ? replyComposer?.getState()
        : undefined,
    });
  }

  function dispose() {
    disposed = true;
    cancelRead();
    replyComposer?.dispose();
    replyComposer = undefined;
    replyId = undefined;
    postHistory = [];
    authority++;
    request++;
    failedContinuation = false;
    state = initial();
  }
  return {
    getState: () => state,
    ownsCurrentPost,
    canDeletePost,
    deleteOwnPost,
    updateSession,
    openNotifications,
    loadMore,
    openPost,
    openReply,
    getReplyComposer: () => replyComposer,
    loadMoreReplies: () => readReplies(true),
    reloadReplies: () => readReplies(false),
    retryReplies: () => readReplies(failedRepliesContinuation),
    showHome,
    back,
    retry,
    reload,
    toggleBookmark,
    pause,
    dispose,
  };
}
