import {
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import {
  appendUniqueMobileItemsById,
  appendUniqueMobileItemsByKey,
  formatMobilePreviewDate,
  type MobileSession,
} from "@takosjp/mobile-kit";
import {
  MobilePreviewCard,
  MobilePreviewList,
  MobilePreviewSection,
} from "@takosjp/mobile-kit/solid";
import {
  loadYurucommuMobileBookmarksPage,
  type YurucommuMobileHome,
} from "./api.ts";
import { createFeedController, type FeedState } from "./feed-controller.ts";
import { PostComposer } from "./post-composer.tsx";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";
import { PostMedia } from "./post-media.tsx";
import {
  displayHostRoutePath,
  hostRouteNoticeFor,
  type HostRouteNotice,
} from "./host-route.ts";

/** Shown when a link asked for a host screen that this app does not have. */
export function HostRouteNoticeBanner(props: {
  notice?: HostRouteNotice;
  session: MobileSession;
  onDismiss: () => void;
}) {
  return (
    <Show when={hostRouteNoticeFor(props.notice, props.session)}>
      {(notice) => (
        <div class="route-notice" role="status">
          <p>
            リンク先の画面（{displayHostRoutePath(notice().path)}
            ）はアプリにありません。フィードを表示しています。
          </p>
          <button
            type="button"
            class="text-button"
            onClick={() => props.onDismiss()}
          >
            閉じる
          </button>
        </div>
      )}
    </Show>
  );
}

export function Feed(props: {
  home?: YurucommuMobileHome;
  session: MobileSession;
  isActive?: () => boolean;
  refreshHome: () => Promise<void>;
  onOpenPost: (apId: string, trigger: HTMLButtonElement) => void;
}) {
  const [state, setState] = createSignal<FeedState>({
    content: "",
    visibility: "public",
    sending: false,
    error: "",
    status: "",
    refreshError: "",
    attachments: [],
    attachmentError: "",
    canSubmit: false,
  });
  const controller = createFeedController({
    session: props.session,
    refreshHome: () => props.refreshHome(),
    isActive: () => props.isActive?.() !== false,
    onChange: setState,
  });
  createRenderEffect(() => controller.updateSession(props.session));
  onCleanup(() => controller.dispose());
  const posts = () =>
    appendUniqueMobileItemsByKey(
      [],
      props.home?.posts ?? [],
      (post) => post.ap_id,
    );
  return (
    <div class="mobile-feed">
      <PostComposer controller={controller} state={state()} />
      <MobilePreviewSection
        title="フィード"
        detail={props.home ? `${posts().length}件` : undefined}
      >
        <Show
          when={props.home}
          fallback={<p class="empty">フィードはまだ取得できていません。</p>}
        >
          <Show
            when={posts().length}
            fallback={<p class="empty">まだ投稿はありません。</p>}
          >
            <MobilePreviewList>
              <For each={posts()}>
                {(post) => (
                  <li>
                    <MobilePreviewCard class="feed-card">
                      <div class="feed-author">
                        <Show when={post.author.icon_url}>
                          <img src={post.author.icon_url!} alt="" />
                        </Show>
                        <div>
                          <strong>
                            {post.author.name ?? post.author.preferred_username}
                          </strong>
                          <small>@{post.author.preferred_username}</small>
                        </div>
                      </div>
                      <p>{post.content}</p>
                      <PostMedia
                        attachments={post.attachments}
                        session={props.session}
                        isActive={props.isActive}
                      />
                      <footer>
                        <button
                          type="button"
                          class="text-button"
                          data-post-id={post.ap_id}
                          data-post-surface="feed"
                          aria-label={`${post.author.name || post.author.preferred_username}の投稿を開く`}
                          onClick={(event) =>
                            props.onOpenPost(post.ap_id, event.currentTarget)
                          }
                        >
                          投稿を開く
                        </button>
                        <span>♡ {post.like_count}</span>
                        <span>返信 {post.reply_count}</span>
                        <Show when={post.published}>
                          {(published) => (
                            <time>
                              {formatMobilePreviewDate(published(), "ja-JP")}
                            </time>
                          )}
                        </Show>
                      </footer>
                    </MobilePreviewCard>
                  </li>
                )}
              </For>
            </MobilePreviewList>
          </Show>
        </Show>
      </MobilePreviewSection>
    </div>
  );
}

export function BookmarksPreview(props: {
  session: MobileSession;
  revision?: number;
  isActive?: () => boolean;
  onOpenPost: (apId: string, trigger: HTMLButtonElement) => void;
}) {
  const [posts, setPosts] = createSignal<
    readonly import("./api.ts").MobilePost[]
  >([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  let active = true;
  let request = 0;
  let activeRead: AbortController | undefined;
  const sessionKey = createMemo(() => feedSessionIdentity(props.session));
  const currentSession = () =>
    untrack(() => snapshotFeedSession(props.session));
  const live = (current: number, key: string) =>
    active &&
    props.isActive?.() !== false &&
    current === request &&
    key === feedSessionIdentity(props.session);
  onCleanup(() => {
    active = false;
    request += 1;
    activeRead?.abort();
    activeRead = undefined;
  });
  async function refresh(
    requestSession = currentSession(),
    key = feedSessionIdentity(requestSession),
  ) {
    const current = ++request;
    activeRead?.abort();
    const read = new AbortController();
    activeRead = read;
    setLoading(true);
    setError(undefined);
    setPosts([]);
    try {
      const next = await loadYurucommuMobileBookmarksPage(
        requestSession,
        read.signal,
      );
      if (!live(current, key)) return;
      const withIds = next.map((post) => ({ ...post, id: post.ap_id }));
      setPosts(appendUniqueMobileItemsById([], withIds));
    } catch (error) {
      if (live(current, key)) {
        setError(
          error instanceof Error
            ? error.message
            : "保存した投稿を取得できませんでした。",
        );
      }
    } finally {
      if (activeRead === read) activeRead = undefined;
      if (live(current, key)) setLoading(false);
    }
  }
  createEffect(() => {
    const key = sessionKey();
    props.revision;
    void refresh(currentSession(), key);
  });
  return (
    <MobilePreviewSection
      title="保存した投稿"
      actions={
        <button
          type="button"
          class="text-button"
          aria-label="保存した投稿を更新"
          disabled={loading()}
          onClick={() => void refresh()}
        >
          更新
        </button>
      }
    >
      <Show when={!loading()} fallback={<p role="status">読み込み中…</p>}>
        <Show when={!error()} fallback={<p role="alert">{error()}</p>}>
          <Show
            when={posts().length}
            fallback={<p class="empty">保存した投稿はありません。</p>}
          >
            <MobilePreviewList>
              <For each={posts().slice(0, 3)}>
                {(post) => (
                  <li>
                    <MobilePreviewCard class="feed-card">
                      <strong>
                        {post.author.name ?? post.author.preferred_username}
                      </strong>
                      <p>{post.content}</p>
                      <PostMedia
                        attachments={post.attachments}
                        session={props.session}
                        isActive={props.isActive}
                      />
                      <button
                        type="button"
                        class="text-button"
                        data-post-id={post.ap_id}
                        data-post-surface="bookmarks"
                        aria-label={`${post.author.name || post.author.preferred_username}の投稿を開く`}
                        onClick={(event) =>
                          props.onOpenPost(post.ap_id, event.currentTarget)
                        }
                      >
                        投稿を開く
                      </button>
                    </MobilePreviewCard>
                  </li>
                )}
              </For>
            </MobilePreviewList>
          </Show>
        </Show>
      </Show>
    </MobilePreviewSection>
  );
}
