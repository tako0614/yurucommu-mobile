import type { MobileSession } from "@takosjp/mobile-kit";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";
import {
  loadMobileProfile,
  loadMobileProfilePosts,
  type MobileProfile,
} from "./profile-api.ts";
import { createNotificationController } from "./notification-controller.ts";
import { createProfileEditController } from "./profile-edit-controller.ts";
import { createProfileFollowController } from "./profile-follow-controller.ts";
import type { MobileNotificationPost } from "./notification-api.ts";
export interface MobileProfileState {
  readonly visible: boolean;
  readonly loading: boolean;
  readonly error: string;
  readonly identifier: string | null;
  readonly actor: MobileProfile | null;
  readonly posts: readonly MobileNotificationPost[];
  readonly postsLoaded: boolean;
  readonly postsLoading: boolean;
  readonly postsLoadingMore: boolean;
  readonly postsError: string;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}
const initial = (): MobileProfileState => ({
  visible: false,
  loading: false,
  error: "",
  identifier: null,
  actor: null,
  posts: [],
  postsLoaded: false,
  postsLoading: false,
  postsLoadingMore: false,
  postsError: "",
  hasMore: false,
  nextCursor: null,
});
const keyOf = (session: MobileSession) =>
  JSON.stringify([feedSessionIdentity(session), session.apiBaseUrl]);
export function createProfileController(options: {
  session: MobileSession;
  isActive?: () => boolean;
  onChange?: () => void;
  confirmDiscardReply?: () => boolean | Promise<boolean>;
  onPostReplied?: () => Promise<void>;
  getActorId?: () => string | undefined;
  confirmDeletePost?: () => boolean | Promise<boolean>;
  onPostDeleteConfirmed?: (postId: string) => void;
  onPostDeleted?: (postId: string) => Promise<void>;
  onBookmarksChanged?: () => void;
  onDeclined?: () => void;
  onRelationshipChanged?: () => Promise<void>;
  onProfileChanged?: () => Promise<void>;
  confirmDiscardProfile?: () => boolean | Promise<boolean>;
}) {
  let session = snapshotFeedSession(options.session),
    key = keyOf(session),
    state = initial(),
    disposed = false,
    retiringFollow = false,
    generation = 0,
    pageRequest = 0;
  let postsInvalidation = 0, loadedInvalidation = 0;
  let actorRead: AbortController | undefined,
    pageRead: AbortController | undefined,
    failedMore = false,
    cursors = new Set<string>();
  const live = () => !disposed && options.isActive?.() !== false;
  const current = (owner: number) =>
    live() && generation === owner && state.visible;
  const changed = () => {
    if (live()) options.onChange?.();
  };
  const publish = (next: MobileProfileState) => {
    state = next;
    retiringFollow = false;
    changed();
  };
  const makePosts = (): ReturnType<typeof createNotificationController> =>
    createNotificationController({
      session,
      isActive: () => live() && state.visible,
      onChange: changed,
      onPostReplied: options.onPostReplied,
      getActorId: options.getActorId,
      confirmDeletePost: options.confirmDeletePost,
      onPostDeleteConfirmed: (id) => {
        postsInvalidation++;
        options.onPostDeleteConfirmed?.(id);
      },
      onPostDeleted: async (id) => {
        // Publish the confirmed deletion to sibling views while this scope is
        // owned, before a slow profile read can be covered or retired.
        const owner = generation;
        let updateFailure: { cause: unknown } | undefined;
        try { await options.onPostDeleted?.(id); }
        catch (cause) { updateFailure = { cause }; }
        if (!current(owner)) return;
        const refreshing = open(state.actor?.ap_id ?? state.identifier, true);
        const refreshOwner = generation;
        const refreshed = await refreshing;
        if (!current(refreshOwner)) return;
        if (!refreshed) throw Error("プロフィールを更新できませんでした。");
        if (updateFailure) throw updateFailure.cause;
      },
      onBookmarksChanged: options.onBookmarksChanged,
      confirmDiscardReply: options.confirmDiscardReply,
    });
  let postController = makePosts();
  const makeEditor = (): ReturnType<typeof createProfileEditController> =>
    createProfileEditController({
      session,
      isActive: () =>
        live() &&
        state.visible &&
        !state.loading &&
        !state.error &&
        state.actor !== null &&
        (editor.getActorId() === null ||
          state.actor.ap_id === editor.getActorId()),
      onChange: changed,
      confirmDiscard: options.confirmDiscardProfile,
      onReceipt: (actor) => {
        if (live() && state.visible && state.actor?.ap_id === actor.ap_id)
          publish({ ...state, actor });
      },
      onSaved: options.onProfileChanged,
    });
  let editor = makeEditor();
  const relationships = new Map<
    string,
    ReturnType<typeof createProfileFollowController>
  >();
  function prepareFollow(actor: MobileProfile) {
    const id = actor.ap_id;
    if (relationships.has(id)) return;
    relationships.set(
      id,
      createProfileFollowController({
        session,
        actorId: id,
        isActive: () =>
          live() &&
          state.visible &&
          !state.loading &&
          !state.error &&
          state.actor?.ap_id === id &&
          postController.getState().page === "home",
        onChange: changed,
        onReceipt: (receipt) => {
          if (
            live() &&
            state.visible &&
            !state.loading &&
            !state.error &&
            state.actor?.ap_id === id
          )
            publish({ ...state, actor: receipt.actor });
        },
        onConfirmed: options.onRelationshipChanged,
      }),
    );
  }
  function setFollowActive(active: boolean) {
    for (const [id, value] of relationships)
      value.setActive(active && !retiringFollow && state.actor?.ap_id === id);
  }
  function disposeRelationships() {
    for (const value of relationships.values()) value.dispose();
    relationships.clear();
  }

  let acceptedIdentifier: string | null | undefined;
  function cancel() {
    // A reactive onChange may run before close/open publishes its next state.
    // It must not rearm the relationship being retired in this same turn.
    retiringFollow = true;
    setFollowActive(false);
    editor.pause();
    actorRead?.abort();
    actorRead = undefined;
    pageRead?.abort();
    pageRead = undefined;
    pageRequest++;
  }
  async function readPage(more: boolean) {
    if (
      !live() ||
      !state.visible ||
      !state.actor ||
      state.loading ||
      (more &&
        (state.postsLoading ||
          state.postsLoadingMore ||
          !state.hasMore ||
          !state.nextCursor))
    )
      return;
    if (!more) {
      pageRead?.abort();
      cursors = new Set();
    }
    const owner = generation,
      request = ++pageRequest,
      id = state.actor.ap_id,
      cursor = more ? state.nextCursor! : undefined,
      read = new AbortController();
    pageRead = read;
    failedMore = false;
    publish({
      ...state,
      postsLoading: !more,
      postsLoadingMore: more,
      postsError: "",
    });
    try {
      const value = await loadMobileProfilePosts(
        session,
        id,
        cursor,
        read.signal,
      );
      if (!current(owner) || pageRequest !== request || pageRead !== read)
        return;
      if (
        value.hasMore &&
        value.nextCursor &&
        (value.nextCursor === cursor || cursors.has(value.nextCursor))
      )
        throw Error(
          "投稿一覧の位置が更新されませんでした。再読み込みしてください。",
        );
      if (value.nextCursor) cursors.add(value.nextCursor);
      const posts = more ? [...state.posts] : [],
        seen = new Set(posts.map((p) => p.ap_id));
      for (const post of value.posts)
        if (!seen.has(post.ap_id)) {
          seen.add(post.ap_id);
          posts.push(post);
        }
      publish({
        ...state,
        posts,
        postsLoaded: true,
        postsLoading: false,
        postsLoadingMore: false,
        postsError: "",
        hasMore: value.hasMore,
        nextCursor: value.nextCursor,
      });
    } catch (cause) {
      if (current(owner) && pageRequest === request && pageRead === read) {
        failedMore = more;
        publish({
          ...state,
          postsLoading: false,
          postsLoadingMore: false,
          postsError:
            cause instanceof Error
              ? cause.message
              : "投稿を読み込めませんでした。",
        });
      }
    } finally {
      if (pageRead === read) pageRead = undefined;
    }
  }
  async function open(
    identifier: string | null,
    refresh = false,
  ): Promise<boolean> {
    if (!live()) return false;
    refresh ||= loadedInvalidation !== postsInvalidation;
    const invalidation = postsInvalidation;
    if (
      !refresh &&
      !state.error &&
      state.actor &&
      (identifier === acceptedIdentifier || identifier === state.actor.ap_id)
    ) {
      generation++;
      cancel();
      publish({
        ...state,
        identifier: acceptedIdentifier ?? state.actor.ap_id,
        visible: true,
        loading: false,
        error: "",
        postsLoading: false,
        postsLoadingMore: false,
      });
      postController.showHome();
      if (!state.postsLoaded) await readPage(false);
      return true;
    }
    const previous = state,
      owner = ++generation;
    cancel();
    postController.pause();
    const read = new AbortController();
    actorRead = read;
    publish({
      ...state,
      identifier,
      visible: true,
      loading: true,
      error: "",
      postsLoading: false,
      postsLoadingMore: false,
    });
    try {
      const actor = await loadMobileProfile(session, identifier, read.signal);
      if (!current(owner) || actorRead !== read) return false;
      const different = state.actor?.ap_id !== actor.ap_id;
      if (different) {
        const draft = postController.getReplyComposer()?.getState();
        if (
          draft &&
          (draft.content.length ||
            draft.attachments.length ||
            draft.sending ||
            draft.error)
        ) {
          let discard = false;
          try {
            discard = (await options.confirmDiscardReply?.()) ?? false;
          } catch {}
          if (!current(owner) || actorRead !== read) return false;
          if (!discard) {
            publish({
              ...previous,
              loading: false,
              postsLoading: false,
              postsLoadingMore: false,
            });
            // Only an actual, still-owned decline may request origin focus.
            // Retired/failed reads also return false, but must have no UI effect.
            if (live() && generation === owner) options.onDeclined?.();
            return false;
          }
        }
        postController.dispose();
        postController = makePosts();
      } else postController.showHome();
      prepareFollow(actor);
      acceptedIdentifier = identifier;
      loadedInvalidation = invalidation;
      publish({
        ...state,
        identifier,
        actor,
        visible: true,
        loading: false,
        error: "",
        ...(different || refresh
          ? {
              posts: [],
              postsLoaded: false,
              postsError: "",
              hasMore: false,
              nextCursor: null,
            }
          : {}),
      });
      if (!state.postsLoaded) await readPage(false);
      return current(owner);
    } catch (cause) {
      if (current(owner) && actorRead === read)
        publish({
          ...state,
          loading: false,
          error:
            cause instanceof Error
              ? cause.message
              : "プロフィールを読み込めませんでした。",
        });
      return false;
    } finally {
      if (actorRead === read) actorRead = undefined;
    }
  }
  function close() {
    if (disposed) return;
    generation++;
    cancel();
    postController.pause();
    publish({
      ...state,
      visible: false,
      loading: false,
      postsLoading: false,
      postsLoadingMore: false,
    });
  }
  function updateSession(next: MobileSession) {
    if (disposed) return;
    const nextKey = keyOf(next);
    if (nextKey === key) return;
    session = snapshotFeedSession(next);
    key = nextKey;
    generation++;
    cancel();
    postController.dispose();
    disposeRelationships();
    editor.dispose();
    state = initial();
    postsInvalidation = loadedInvalidation = 0;
    acceptedIdentifier = undefined;
    postController = makePosts();
    editor = makeEditor();
    changed();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation++;
    cancel();
    postController.dispose();
    disposeRelationships();
    editor.dispose();
    state = initial();
  }
  return {
    getState: () => state,
    getPostController: () => postController,
    getEditor: () => editor,
    getFollowController: () =>
      state.actor ? relationships.get(state.actor.ap_id) : undefined,
    setFollowActive,
    // Refresh canonical actor/count/posts on the next open; never open a hidden
    // profile or send a request just because another view deleted a post.
    invalidatePosts: () => { if (live()) postsInvalidation++; },
    open,
    close,
    updateSession,
    dispose,
    reload: () =>
      open(
        state.error
          ? state.identifier
          : (state.actor?.ap_id ?? state.identifier),
        true,
      ),
    loadMore: () => readPage(true),
    retryPosts: () => readPage(failedMore),
    reloadPosts: () => readPage(false),
  };
}
