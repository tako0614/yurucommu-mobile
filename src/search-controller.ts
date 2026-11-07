import type { MobileSession } from "@takosjp/mobile-kit";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";
import {
  loadMobileSearch,
  loadMobileSearchInitial,
  type MobileSearchActor,
  type MobileSearchKind,
  type MobileSearchSelection,
} from "./search-api.ts";
import type { MobileNotificationPost } from "./notification-api.ts";

export interface MobileSearchState {
  readonly visible: boolean;
  readonly query: string;
  readonly kind: MobileSearchKind;
  readonly resultQuery: string;
  readonly resultKind: MobileSearchKind;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string;
  readonly posts: readonly MobileNotificationPost[];
  readonly actors: readonly MobileSearchActor[];
  readonly hasMore: boolean;
  readonly nextOffset: number;
  readonly canLoadMore: boolean;
  readonly canRetry: boolean;
}
const initial = (): MobileSearchState => ({
  visible: false, query: "", kind: "posts", resultQuery: "", resultKind: "posts",
  loaded: false, loading: false, loadingMore: false, error: "",
  posts: [], actors: [], hasMore: false, nextOffset: 0, canLoadMore: false, canRetry: false,
});
const keyOf = (session: MobileSession) =>
  JSON.stringify([feedSessionIdentity(session), session.apiBaseUrl]);
const unique = <T extends { readonly ap_id: string }>(items: readonly T[]) => {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.ap_id)) return false;
    seen.add(item.ap_id);
    return true;
  });
};

export function createSearchController(options: {
  session: MobileSession;
  isActive?: () => boolean;
  onChange?: () => void;
  projectPosts?: (posts: readonly MobileNotificationPost[]) => readonly MobileNotificationPost[];
}) {
  let session = snapshotFeedSession(options.session), key = keyOf(session);
  let state = initial(), disposed = false, generation = 0;
  let read: AbortController | undefined;
  let lastTarget: { query: string; kind: MobileSearchSelection; more: boolean; inputRevision: number } | undefined;
  let inputRevision = 0;
  const live = () => !disposed && options.isActive?.() !== false;
  const publish = (next: MobileSearchState) => {
    state = {
      ...next,
      canLoadMore: next.loaded && next.hasMore && next.nextOffset <= 10000 &&
        !next.loading && !next.loadingMore,
    };
    if (live()) options.onChange?.();
  };
  const retire = () => { generation++; read?.abort(); read = undefined; };
  async function run(more: boolean, retry?: { query: string; kind: MobileSearchSelection; inputRevision?: number }) {
    if (!live() || !state.visible || (more && !state.canLoadMore)) return false;
    const query = retry?.query ?? (more ? state.resultQuery : state.query.trim());
    const kind = retry?.kind ?? (more ? state.resultKind : state.kind);
    if (!query || (kind !== "actors" && query === "#")) {
      lastTarget = undefined;
      publish({ ...state, canRetry: false, error: "検索語を入力してください。" });
      return false;
    }
    retire();
    const owner = generation, controller = new AbortController();
    const draftRevision = retry?.inputRevision ?? inputRevision;
    read = controller;
    const offset = more ? state.nextOffset : 0;
    lastTarget = { query, kind, more, inputRevision: draftRevision };
    publish({ ...state, ...(!more ? {
      resultQuery: query, resultKind: kind === "auto" ? state.kind : kind, posts: [], actors: [], loaded: false,
      hasMore: false, nextOffset: 0,
    } : {}), loading: !more, loadingMore: more, canRetry: false, error: "" });
    const current = () => live() && state.visible && owner === generation;
    try {
      const resultKind = state.resultKind;
      const page = more
        ? { ...await loadMobileSearch(session, query, resultKind, offset, controller.signal), kind: resultKind }
        : await loadMobileSearchInitial(session, query, kind, controller.signal);
      if (!current()) return false;
      publish({ ...state, loaded: true, loading: false, loadingMore: false,
        resultKind: page.kind,
        ...(kind === "auto" && inputRevision === draftRevision ? { kind: page.kind } : {}),
        posts: options.projectPosts?.(unique([...state.posts, ...page.posts])) ?? unique([...state.posts, ...page.posts]),
        actors: unique([...state.actors, ...page.actors]), hasMore: page.hasMore,
        nextOffset: page.nextOffset, error: "", canRetry: false });
      return true;
    } catch (cause) {
      if (!current()) return false;
      publish({ ...state, loading: false, loadingMore: false, canRetry: true,
        error: cause instanceof Error ? cause.message : "検索できませんでした。再試行できます。" });
      return false;
    } finally { if (owner === generation) read = undefined; }
  }
  function pause() {
    const pending = state.loading || state.loadingMore;
    retire();
    if (pending) publish({ ...state, loading: false, loadingMore: false, canRetry: true,
      error: "検索を中断しました。再試行できます。" });
  }
  return {
    getState: () => state,
    open(query?: string, kind?: MobileSearchSelection) {
      if (!live()) return;
      if (query !== undefined) {
        retire(); lastTarget = undefined;
        inputRevision++;
        publish({ ...initial(), visible: true, query, kind: kind === "auto" ? "posts" : kind ?? state.kind });
      } else publish({ ...state, visible: true, ...(kind && kind !== "auto" ? { kind } : {}) });
      if (query?.trim()) void run(false, { query: query.trim(), kind: kind ?? state.kind });
    },
    close() { pause(); publish({ ...state, visible: false }); },
    setQuery(query: string) { if (live()) { inputRevision++; publish({ ...state, query }); } },
    setKind(kind: MobileSearchKind) { if (live()) { inputRevision++; publish({ ...state, kind }); } },
    search: () => run(false),
    loadMore: () => run(true),
    retry: () => state.canRetry && lastTarget ? run(lastTarget.more, lastTarget) : Promise.resolve(false),
    pause,
    applyPostEdits() {
      publish({ ...state, posts: options.projectPosts?.(state.posts) ?? state.posts });
    },
    updateSession(next: MobileSession) {
      const selected = snapshotFeedSession(next), nextKey = keyOf(selected);
      session = selected;
      if (key === nextKey) return;
      key = nextKey; retire(); inputRevision++; lastTarget = undefined; publish(initial());
    },
    dispose() { retire(); disposed = true; state = initial(); },
  };
}
