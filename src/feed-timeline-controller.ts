import { appendUniqueMobileItemsByKey, type MobileSession } from "@takosjp/mobile-kit";
import { loadMobileTimelinePage, type MobilePost, type MobileTimelineContinuation, type YurucommuMobileHome } from "./api.ts";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";

export interface FeedTimelineState {
  readonly posts: readonly MobilePost[];
  readonly loading: boolean;
  readonly error: string;
  readonly status: string;
  readonly continuationKnown: boolean;
  readonly hasMore: boolean;
  readonly canLoadMore: boolean;
}

export function createFeedTimelineController(options: {
  session: MobileSession;
  home?: YurucommuMobileHome;
  isActive?: () => boolean;
  projectPosts?: (posts: readonly MobilePost[]) => readonly MobilePost[];
  onChange?: (state: FeedTimelineState) => void;
}) {
  let session = snapshotFeedSession(options.session), scope = feedSessionIdentity(session);
  let home = options.home, incarnation = home?.timeline ?? home;
  let continuation: MobileTimelineContinuation = home?.timeline ?? { hasMore: null, nextCursor: null };
  let extra: readonly MobilePost[] = [], loading = false, error = "", status = "";
  let generation = 0, disposed = false, pending: AbortController | undefined;
  const consumed = new Set<string>();
  const live = () => !disposed && options.isActive?.() !== false;
  function getState(): FeedTimelineState {
    const merged = appendUniqueMobileItemsByKey(home?.posts ?? [], extra, post => post.ap_id);
    return {
      posts: options.projectPosts?.(merged) ?? merged, loading, error, status,
      continuationKnown: continuation.hasMore !== null,
      hasMore: continuation.hasMore === true,
      canLoadMore: live() && !!home && !loading && continuation.hasMore === true && !!continuation.nextCursor,
    };
  }
  const publish = () => { if (!disposed) options.onChange?.(getState()); };
  const retire = () => { generation++; pending?.abort(); pending = undefined; loading = false; };

  function updateHome(nextSession: MobileSession, nextHome?: YurucommuMobileHome) {
    if (disposed) return;
    const nextScope = feedSessionIdentity(nextSession), nextIncarnation = nextHome?.timeline ?? nextHome;
    const reset = scope !== nextScope || incarnation !== nextIncarnation || home?.actor.ap_id !== nextHome?.actor.ap_id;
    session = snapshotFeedSession(nextSession);
    scope = nextScope;
    home = nextHome;
    incarnation = nextIncarnation;
    if (reset) {
      retire(); extra = []; consumed.clear(); error = ""; status = "";
      continuation = home?.timeline ?? { hasMore: null, nextCursor: null };
    }
    publish();
  }

  function pause() {
    if (disposed || !pending) return;
    retire();
    error = "読み込みを中断しました。続きを再試行できます。";
    publish();
  }

  async function loadMore() {
    if (!getState().canLoadMore) return;
    const before = continuation.nextCursor!, owner = ++generation;
    const read = new AbortController(); pending = read; loading = true; error = ""; status = "";
    try {
      publish();
      if (!live() || generation !== owner) return;
      const page = await loadMobileTimelinePage(session, before, read.signal);
      if (!live() || generation !== owner) return;
      if (page.hasMore === null || page.hasMore &&
        (!page.nextCursor || page.nextCursor === before || consumed.has(page.nextCursor)))
        throw new Error("フィードの続き位置が進みません。ホームを更新してください。");
      extra = appendUniqueMobileItemsByKey(extra, page.posts, post => post.ap_id);
      consumed.add(before);
      continuation = { hasMore: page.hasMore, nextCursor: page.nextCursor };
      status = page.hasMore ? "以前の投稿を読み込みました。続きも確認できます。" : "以前の投稿の最後まで確認しました。";
    } catch (cause) {
      if (live() && generation === owner)
        error = cause instanceof Error ? cause.message : "以前の投稿を読み込めませんでした。";
    } finally {
      if (pending === read) { pending = undefined; loading = false; publish(); }
    }
  }

  function dispose() {
    retire(); disposed = true; home = undefined; extra = []; consumed.clear();
  }
  return { getState, updateHome, loadMore, pause, dispose };
}
