import { createEffect, For, on, Show } from "solid-js";
import { formatMobilePreviewDate } from "@takosjp/mobile-kit";
import type { MobileSession } from "@takosjp/mobile-kit";
import { PostMedia } from "./post-media.tsx";
import { PostLike } from "./post-like.tsx";
import type { PostLikeStore } from "./post-like-controller.ts";
import { PostComposer } from "./post-composer.tsx";
import {
  MobilePreviewCard,
  MobilePreviewList,
  MobilePreviewSection,
} from "@takosjp/mobile-kit/solid";
import type {
  NotificationState,
  createNotificationController,
} from "./notification-controller.ts";

type Controller = ReturnType<typeof createNotificationController>;
const labels: Record<string, string> = {
  follow: "フォローしました",
  follow_request: "フォローをリクエストしました",
  like: "いいねしました",
  announce: "リポストしました",
  reply: "返信しました",
  mention: "あなたに言及しました",
};

// Keep ActivityPub HTML inert. Content is displayed as text, without loading
// remote images or treating a notification's content as executable markup.
export function postText(content: string): string {
  const template = document.createElement("template");
  template.innerHTML = content;
  template.content
    .querySelectorAll("script,style,noscript")
    .forEach((node) => node.remove());
  template.content
    .querySelectorAll("br")
    .forEach((node) => node.replaceWith("\n"));
  template.content
    .querySelectorAll("p,div,li")
    .forEach((node) => node.append("\n"));
  return template.content.textContent?.trim() ?? "";
}

export function NotificationScreen(props: {
  session: MobileSession;
  state: NotificationState;
  controller: Controller;
  isActive?: () => boolean;
  homeFocus?: () => HTMLElement | undefined;
  likes: PostLikeStore;
  onOpenProfile: (identifier: string, trigger: HTMLButtonElement) => void;
}) {
  let heading: HTMLHeadingElement | undefined;
  let openButton: HTMLButtonElement | undefined;
  createEffect(
    on(
      () => [props.state.post?.ap_id, props.state.repliesLoaded, props.isActive?.() !== false] as const,
      ([id, loaded, active], previous) => {
        if (
          id && active && !loaded && props.state.page === "post" &&
          !props.state.repliesLoading &&
          (!previous || id !== previous[0] || previous[1] || !previous[2])
        )
          void props.controller.reloadReplies();
      },
    ),
  );
  createEffect(
    on(
      () => [props.state.page, props.state.post?.ap_id, props.state.postDeleteStatus] as const,
      ([page, id, deleted], previous) => {
        if (previous && page === previous[0] && id === previous[1] && deleted === previous[2]) return;
        if (page === "post" && !id && previous?.[0] === "post") return;
        queueMicrotask(() => {
          if (props.state.page !== page || props.isActive?.() === false) return;
          if (deleted && previous && deleted !== previous[2] && document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
          const target =
            page === "home" ? (props.homeFocus?.() ?? openButton) : heading;
          if (target?.isConnected) target.focus();
        });
      },
      { defer: true },
    ),
  );
  return (
    <section class="native-notifications" aria-label="通知と投稿">
      <Show when={props.state.postDeleteStatus}><p role="status">{props.state.postDeleteStatus}</p></Show>
      <Show
        when={props.state.page !== "home"}
        fallback={
          <button
            ref={openButton}
            type="button"
            class="primary"
            onClick={() => void props.controller.openNotifications()}
          >
            通知を開く
          </button>
        }
      >
        <div class="native-notification-toolbar">
          <button
            type="button"
            class="text-button"
            onClick={() => void props.controller.back()}
          >
            {props.state.page === "post" ? "戻る" : "フィードへ戻る"}
          </button>
          <button
            type="button"
            class="text-button"
            disabled={
              props.state.loading ||
              props.state.loadingMore ||
              props.state.bookmarkBusy || props.state.postDeleteBusy
            }
            onClick={() => void props.controller.reload()}
          >
            再読み込み
          </button>
        </div>
        <h2 ref={heading} tabIndex={-1}>
          {props.state.page === "post" ? "投稿" : "通知"}
        </h2>
        <Show when={props.state.loading}>
          <p role="status">読み込み中…</p>
        </Show>
        <Show when={props.state.error}>
          <div role="alert">
            <p>{props.state.error}</p>
            <button
              type="button"
              class="text-button"
              disabled={props.state.loading || props.state.loadingMore}
              onClick={() => void props.controller.retry()}
            >
              再試行
            </button>
          </div>
        </Show>
        <Show when={props.state.page === "notifications"}>
          <Show
            when={
              props.state.listLoaded && props.state.notifications.length === 0
            }
          >
            <p class="empty">通知はまだありません。</p>
          </Show>
          <MobilePreviewList>
            <For each={props.state.notifications}>
              {(notification) => (
                <li>
                  <MobilePreviewCard class="native-notification-card">
                    <p>
                      <button
                        type="button"
                        class="text-button"
                        data-profile-id={notification.actor.ap_id}
                        aria-label={`${notification.actor.name || notification.actor.preferred_username || "通知の投稿者"}のプロフィールを開く`}
                        onClick={(event) =>
                          props.onOpenProfile(
                            notification.actor.ap_id,
                            event.currentTarget,
                          )
                        }
                      >
                        {notification.actor.name ||
                          notification.actor.preferred_username ||
                          notification.actor.ap_id}
                      </button>{" "}
                      が{labels[notification.type] ?? "通知を送りました"}
                    </p>
                    <time>
                      {formatMobilePreviewDate(
                        notification.created_at,
                        "ja-JP",
                      )}
                    </time>
                    <Show when={!notification.read}>
                      <span class="notification-unread">未読</span>
                    </Show>
                    <Show
                      when={
                        notification.target_kind === "post" &&
                        notification.target_id
                      }
                    >
                      <button
                        type="button"
                        class="text-button"
                        onClick={() =>
                          void props.controller.openPost(
                            notification.target_id!,
                          )
                        }
                      >
                        投稿を開く
                      </button>
                    </Show>
                    <Show
                      when={
                        notification.target_kind === "profile" &&
                        notification.target_id
                      }
                    >
                      <button
                        type="button"
                        class="text-button"
                        onClick={(event) =>
                          props.onOpenProfile(
                            notification.target_id!,
                            event.currentTarget,
                          )
                        }
                      >
                        プロフィールを開く
                      </button>
                    </Show>
                  </MobilePreviewCard>
                </li>
              )}
            </For>
          </MobilePreviewList>
          <Show when={props.state.hasMore}>
            <button
              type="button"
              class="text-button"
              disabled={props.state.loading || props.state.loadingMore}
              onClick={() => void props.controller.loadMore()}
            >
              {props.state.loadingMore ? "読み込み中…" : "さらに表示"}
            </button>
          </Show>
        </Show>
        <Show when={props.state.page === "post" && props.state.post}>
          {(post) => (
            <>
              <MobilePreviewCard class="native-notification-post">
                <PostLike
                  session={props.session}
                  post={post()}
                  isActive={() =>
                    props.isActive?.() !== false && props.state.page === "post" &&
                    !props.state.postDeleteBusy && !props.state.postDeleteNeedsReload
                  }
                  store={props.likes}
                />
                <p>
                  <button
                    type="button"
                    class="text-button"
                    data-profile-id={post().author.ap_id}
                    aria-label={`${post().author.name || post().author.preferred_username || "投稿者"}のプロフィールを開く`}
                    onClick={(event) =>
                      props.onOpenProfile(
                        post().author.ap_id,
                        event.currentTarget,
                      )
                    }
                  >
                    {post().author.name ||
                      post().author.preferred_username ||
                      post().author.ap_id}
                  </button>
                </p>
                <p>{postText(post().content)}</p>
                <PostMedia
                  attachments={post().attachments}
                  session={props.session}
                />
                <Show
                  when={post().bookmarkState !== null}
                  fallback={
                    <p>このサーバーの応答では保存状態を確認できません。</p>
                  }
                >
                  <button
                    type="button"
                    class="text-button"
                    aria-pressed={post().bookmarkState === true}
                    disabled={
                      props.state.bookmarkBusy ||
                      props.state.bookmarkNeedsReload || props.state.postDeleteBusy || props.state.postDeleteNeedsReload
                    }
                    onClick={() => void props.controller.toggleBookmark()}
                  >
                    {props.state.bookmarkBusy
                      ? "保存中…"
                      : post().bookmarkState
                        ? "保存を解除"
                        : "投稿を保存"}
                  </button>
                </Show>
                <Show when={props.state.bookmarkError}>
                  <p role="alert">{props.state.bookmarkError}</p>
                </Show>
                <Show when={props.state.post && props.controller.ownsCurrentPost()}>
                  <button type="button" class="text-button" disabled={props.state.page !== "post" || !props.controller.canDeletePost()} onClick={() => void props.controller.deleteOwnPost()}>
                    {props.state.postDeleteBusy ? "削除中…" : "投稿を削除"}
                  </button>
                  <Show when={props.state.replyDraft && (props.state.replyDraft.content.length || props.state.replyDraft.attachments.length || props.state.replyDraft.sending)}>
                    <p>返信の下書き・添付や送信中の返信を整理してから削除してください。</p>
                  </Show>
                </Show>
                <Show when={props.state.postDeleteError}>
                  <div role="alert">
                    <p>{props.state.postDeleteError}</p>
                    <button type="button" class="text-button" disabled={props.state.postDeleteBusy || props.state.loading} onClick={() => void props.controller.reload()}>削除状態を再読み込み</button>
                  </div>
                </Show>
                <Show when={post().published} fallback={<span>日時不明</span>}>
                  {(published) => (
                    <time dateTime={published()}>
                      {formatMobilePreviewDate(published(), "ja-JP")}
                    </time>
                  )}
                </Show>
              </MobilePreviewCard>
              <Show
                when={post().replyContext}
                fallback={<p>この投稿の返信先・公開範囲を確認できません。</p>}
              >
                <Show when={!props.state.postDeleteBusy && !props.state.postDeleteNeedsReload ? props.state.replyDraft : undefined}>
                  {(draft) => (
                    <PostComposer
                      controller={props.controller.getReplyComposer()!}
                      state={draft()}
                      reply
                      community={!!post().replyContext?.communityApId}
                      chooseReplyAudience={
                        post().replyContext?.visibility === "followers"
                      }
                      authorMention={
                        /^[A-Za-z0-9_]+(?:@[A-Za-z0-9.-]+)?$/.test(
                          post().author.username ?? "",
                        )
                          ? `@${post().author.username}`
                          : undefined
                      }
                    />
                  )}
                </Show>
              </Show>
              <MobilePreviewSection
                title="返信"
                actions={
                  <button
                    type="button"
                    class="text-button"
                    disabled={
                      props.state.repliesLoading ||
                      props.state.repliesLoadingMore
                    }
                    onClick={() => void props.controller.reloadReplies()}
                  >
                    返信を再読み込み
                  </button>
                }
              >
                <Show when={props.state.repliesLoading}>
                  <p role="status">返信を読み込み中…</p>
                </Show>
                <Show when={props.state.repliesError}>
                  <div role="alert">
                    <p>{props.state.repliesError}</p>
                    <button
                      type="button"
                      class="text-button"
                      disabled={
                        props.state.repliesLoading ||
                        props.state.repliesLoadingMore
                      }
                      onClick={() => void props.controller.retryReplies()}
                    >
                      返信を再試行
                    </button>
                  </div>
                </Show>
                <Show
                  when={
                    props.state.repliesLoaded &&
                    !props.state.replies.length &&
                    !props.state.repliesLoading &&
                    !props.state.repliesError
                  }
                >
                  <p class="empty">
                    {props.state.repliesHasMore
                      ? "このページには表示できる返信がありません。続きの返信を確認できます。"
                      : "返信はまだありません。"}
                  </p>
                </Show>
                <MobilePreviewList>
                  <For each={props.state.replies}>
                    {(reply) => (
                      <li>
                        <MobilePreviewCard class="native-notification-post">
                          <PostLike
                            session={props.session}
                            post={reply}
                            isActive={() =>
                              props.isActive?.() !== false &&
                              props.state.page === "post"
                            }
                            store={props.likes}
                          />
                          <button
                            type="button"
                            class="text-button"
                            data-profile-id={reply.author.ap_id}
                            aria-label={`${reply.author.name || reply.author.preferred_username || "投稿者"}のプロフィールを開く`}
                            onClick={(event) =>
                              props.onOpenProfile(
                                reply.author.ap_id,
                                event.currentTarget,
                              )
                            }
                          >
                            {reply.author.name ||
                              reply.author.preferred_username ||
                              reply.author.ap_id}
                          </button>
                          <p>{postText(reply.content)}</p>
                          <PostMedia
                            attachments={reply.attachments}
                            session={props.session}
                          />
                          <button
                            type="button"
                            class="text-button"
                            aria-label={`${reply.author.name || reply.author.preferred_username}の返信を開く`}
                            onClick={() =>
                              void props.controller.openReply(reply.ap_id)
                            }
                          >
                            この返信を開く
                          </button>
                        </MobilePreviewCard>
                      </li>
                    )}
                  </For>
                </MobilePreviewList>
                <Show when={props.state.repliesHasMore}>
                  <button
                    type="button"
                    class="text-button"
                    disabled={
                      props.state.repliesLoading ||
                      props.state.repliesLoadingMore
                    }
                    onClick={() => void props.controller.loadMoreReplies()}
                  >
                    {props.state.repliesLoadingMore
                      ? "読み込み中…"
                      : "返信をさらに表示"}
                  </button>
                </Show>
              </MobilePreviewSection>
            </>
          )}
        </Show>
      </Show>
    </section>
  );
}
