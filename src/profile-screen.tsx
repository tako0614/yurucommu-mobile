import { createEffect, createRenderEffect, For, on, Show } from "solid-js";
import type { MobileSession } from "@takosjp/mobile-kit";
import { formatMobilePreviewDate } from "@takosjp/mobile-kit";
import {
  MobilePreviewCard,
  MobilePreviewList,
  MobilePreviewSection,
} from "@takosjp/mobile-kit/solid";
import type { createProfileController } from "./profile-controller.ts";
import type { PostLikeStore } from "./post-like-controller.ts";
import { NotificationScreen, postText } from "./notification-screen.tsx";
import { PostMedia } from "./post-media.tsx";
import { PostLike } from "./post-like.tsx";
export function ProfileScreen(props: {
  session: MobileSession;
  controller: ReturnType<typeof createProfileController>;
  revision: number;
  likes: PostLikeStore;
  isActive?: () => boolean;
  onClose: () => void;
  onOpenProfile: (identifier: string, trigger: HTMLButtonElement) => void;
}) {
  const state = () => {
    props.revision;
    return props.controller.getState();
  };
  const posts = () => {
    props.revision;
    return props.controller.getPostController();
  };
  const postState = () => {
    props.revision;
    return posts().getState();
  };
  const follow = () => {
    props.revision;
    return props.controller.getFollowController();
  };
  const followState = () => follow()?.getState();
  createRenderEffect(() =>
    props.controller.setFollowActive(
      state().visible &&
        !state().loading &&
        !state().error &&
        postState().page === "home" &&
        props.isActive?.() !== false,
    ),
  );
  let followButton: HTMLButtonElement | undefined,
    followReadButton: HTMLButtonElement | undefined;
  async function followAction(readOnly: boolean) {
    const operation = follow();
    if (!operation) return;
    const origin = readOnly ? followReadButton : followButton;
    const restore = document.activeElement === origin;
    const owned = await (readOnly ? operation.reload() : operation.change());
    if (
      !owned ||
      !restore ||
      operation !== follow() ||
      !state().visible ||
      state().loading ||
      postState().page !== "home" ||
      props.isActive?.() === false ||
      document.activeElement !== document.body
    )
      return;
    const value = operation.getState(),
      target =
        value.needsReload || value.status === null
          ? followReadButton
          : value.isSelf
            ? heading
            : followButton;
    if (
      target?.isConnected &&
      (!(target instanceof HTMLButtonElement) || !target.disabled)
    )
      target.focus();
  }
  let heading: HTMLHeadingElement | undefined,
    root: HTMLElement | undefined,
    postOrigin: HTMLButtonElement | undefined,
    originId: string | undefined;
  createEffect(
    on(
      () =>
        [
          state().visible,
          state().loading,
          state().actor?.ap_id,
          state().error,
          postState().page,
        ] as const,
      (next, previous) => {
        if (previous && next.every((value, index) => value === previous[index]))
          return;
        if (!state().visible || state().loading || postState().page !== "home")
          return;
        const fromPost = previous?.[4] === "post";
        queueMicrotask(() => {
          if (!state().visible || props.isActive?.() === false) return;
          const target = fromPost
            ? postOrigin?.isConnected
              ? postOrigin
              : (Array.from(
                  root?.querySelectorAll<HTMLButtonElement>(
                    "button[data-profile-post-id]",
                  ) ?? [],
                ).find((button) => button.dataset.profilePostId === originId) ??
                heading)
            : heading;
          if (target?.isConnected) target.focus();
        });
      },
    ),
  );
  return (
    <section
      ref={root}
      aria-label="プロフィール"
      hidden={!state().visible}
      style={{ "overflow-wrap": "anywhere" }}
    >
      <MobilePreviewSection
        title="プロフィール"
        actions={
          <button type="button" class="text-button" onClick={props.onClose}>
            元の画面へ戻る
          </button>
        }
      >
        <h2 ref={heading} tabIndex={-1}>
          {!state().loading && !state().error
            ? state().actor?.name ||
              state().actor?.preferred_username ||
              "プロフィール"
            : "プロフィール"}
        </h2>
        <Show when={state().loading}>
          <p role="status">プロフィールを読み込み中…</p>
        </Show>
        <Show when={state().error}>
          <div role="alert">
            <p>{state().error}</p>
            <button
              type="button"
              class="text-button"
              onClick={() => void props.controller.reload()}
            >
              プロフィールを再試行
            </button>
          </div>
        </Show>
        <Show when={state().actor && !state().loading && !state().error}>
          <Show
            when={postState().page === "home"}
            fallback={
              <NotificationScreen
                session={props.session}
                state={postState()}
                controller={posts()}
                likes={props.likes}
                isActive={() => state().visible && props.isActive?.() !== false}
                onOpenProfile={props.onOpenProfile}
                homeFocus={() => heading}
              />
            }
          >
            <MobilePreviewCard class="native-notification-post">
              <p>{state().actor!.username ?? state().actor!.ap_id}</p>
              <p>{postText(state().actor!.summary ?? "")}</p>
              <Show when={followState()}>
                {(value) => (
                  <div aria-label="フォロー操作">
                    <Show
                      when={value().isSelf === true}
                      fallback={
                        <>
                          <Show when={value().status !== null}>
                            <button
                              ref={followButton}
                              type="button"
                              class="primary"
                              disabled={!value().canChange}
                              aria-label={
                                value().status === "none"
                                  ? "フォローする"
                                  : value().status === "pending"
                                    ? "フォロー申請を取り消す"
                                    : "フォローを解除する"
                              }
                              onClick={() => void followAction(false)}
                            >
                              {value().busy
                                ? "確認中…"
                                : value().status === "none"
                                  ? "フォローする"
                                  : value().status === "pending"
                                    ? "申請中・取り消す"
                                    : "フォロー中・解除する"}
                            </button>
                          </Show>
                          <Show
                            when={
                              value().needsReload || value().status === null
                            }
                          >
                            <button
                              ref={followReadButton}
                              type="button"
                              class="text-button"
                              disabled={value().busy}
                              onClick={() => void followAction(true)}
                            >
                              フォロー状態を確認
                            </button>
                          </Show>
                        </>
                      }
                    >
                      <p>自分のプロフィール</p>
                    </Show>
                    <Show when={value().busy}>
                      <p role="status">フォロー状態を確認中…</p>
                    </Show>
                    <Show when={value().error}>
                      <p role="alert">{value().error}</p>
                    </Show>
                    <Show when={value().message}>
                      <p role="status">{value().message}</p>
                    </Show>
                    <Show when={value().refreshError}>
                      <p role="alert">{value().refreshError}</p>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={state().actor!.icon_url}>
                {(icon) => (
                  <PostMedia
                    attachments={[
                      { type: "Image", url: icon(), name: "プロフィール画像" },
                    ]}
                    session={props.session}
                    isActive={() =>
                      state().visible && props.isActive?.() !== false
                    }
                  />
                )}
              </Show>
              <dl>
                <dt>フォロワー</dt>
                <dd>{state().actor!.follower_count ?? "不明"}</dd>
                <dt>フォロー中</dt>
                <dd>{state().actor!.following_count ?? "不明"}</dd>
                <dt>投稿</dt>
                <dd>{state().actor!.post_count ?? "不明"}</dd>
              </dl>
              <Show when={state().actor!.is_private === true}>
                <p>非公開プロフィール</p>
              </Show>
              <For each={state().actor!.fields}>
                {(field) => (
                  <div>
                    <strong>{postText(field.name)}</strong>
                    <p>{postText(field.value)}</p>
                  </div>
                )}
              </For>
              <Show when={state().actor!.moved_to}>
                {(moved) => (
                  <button
                    type="button"
                    class="text-button"
                    onClick={(event) =>
                      props.onOpenProfile(moved(), event.currentTarget)
                    }
                  >
                    移転先のプロフィールを開く
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="text-button"
                onClick={() => void props.controller.reload()}
                disabled={followState()?.busy}
              >
                プロフィールを更新
              </button>
            </MobilePreviewCard>
            <MobilePreviewSection
              title="プロフィールの投稿"
              actions={
                <button
                  type="button"
                  class="text-button"
                  disabled={state().postsLoading || state().postsLoadingMore}
                  onClick={() => void props.controller.reloadPosts()}
                >
                  投稿一覧を更新
                </button>
              }
            >
              <Show when={state().postsLoading}>
                <p role="status">投稿を読み込み中…</p>
              </Show>
              <Show when={state().postsError}>
                <div role="alert">
                  <p>{state().postsError}</p>
                  <button
                    type="button"
                    class="text-button"
                    disabled={state().postsLoading || state().postsLoadingMore}
                    onClick={() => void props.controller.retryPosts()}
                  >
                    投稿一覧を再試行
                  </button>
                </div>
              </Show>
              <Show
                when={
                  state().postsLoaded &&
                  !state().postsLoading &&
                  !state().postsError &&
                  !state().posts.length
                }
              >
                <p>
                  {state().hasMore
                    ? "このページには表示できる投稿がありません。続きを確認できます。"
                    : "表示できる投稿はありません。"}
                </p>
              </Show>
              <MobilePreviewList>
                <For each={state().posts}>
                  {(post) => (
                    <li>
                      <MobilePreviewCard class="native-notification-post">
                        <p>{postText(post.content)}</p>
                        <PostMedia
                          attachments={post.attachments}
                          session={props.session}
                          isActive={() =>
                            state().visible &&
                            postState().page === "home" &&
                            props.isActive?.() !== false
                          }
                        />
                        <PostLike
                          session={props.session}
                          post={post}
                          store={props.likes}
                          isActive={() =>
                            state().visible &&
                            postState().page === "home" &&
                            props.isActive?.() !== false
                          }
                        />
                        <Show when={post.published}>
                          {(date) => (
                            <time dateTime={date()}>
                              {formatMobilePreviewDate(date(), "ja-JP")}
                            </time>
                          )}
                        </Show>
                        <button
                          type="button"
                          class="text-button"
                          aria-label="プロフィールの投稿を開く"
                          data-profile-post-id={post.ap_id}
                          onClick={(event) => {
                            postOrigin = event.currentTarget;
                            originId = post.ap_id;
                            void posts().openPost(post.ap_id);
                          }}
                        >
                          投稿を開く
                        </button>
                      </MobilePreviewCard>
                    </li>
                  )}
                </For>
              </MobilePreviewList>
              <Show when={state().hasMore}>
                <button
                  type="button"
                  class="text-button"
                  disabled={state().postsLoading || state().postsLoadingMore}
                  onClick={() => void props.controller.loadMore()}
                >
                  {state().postsLoadingMore
                    ? "読み込み中…"
                    : "投稿をさらに表示"}
                </button>
              </Show>
            </MobilePreviewSection>
          </Show>
        </Show>
      </MobilePreviewSection>
    </section>
  );
}
