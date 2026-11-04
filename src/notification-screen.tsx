import { createEffect, For, on, Show } from "solid-js";
import { formatMobilePreviewDate } from "@takosjp/mobile-kit";
import {
  MobilePreviewCard,
  MobilePreviewList,
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
function postText(content: string): string {
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
  state: NotificationState;
  controller: Controller;
}) {
  let heading: HTMLHeadingElement | undefined;
  let openButton: HTMLButtonElement | undefined;
  createEffect(
    on(
      () => props.state.page,
      (page, previous) => {
        if (page === previous) return;
        queueMicrotask(() => {
          if (props.state.page !== page) return;
          const target = page === "home" ? openButton : heading;
          if (target?.isConnected) target.focus();
        });
      },
      { defer: true },
    ),
  );
  return (
    <section class="native-notifications" aria-label="通知と投稿">
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
            disabled={props.state.loading || props.state.loadingMore}
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
                      <strong>
                        {notification.actor.name ||
                          notification.actor.preferred_username}
                      </strong>{" "}
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
            <MobilePreviewCard class="native-notification-post">
              <p>
                <strong>
                  {post().author.name || post().author.preferred_username}
                </strong>
              </p>
              <p>{postText(post().content)}</p>
              <Show when={post().published} fallback={<span>日時不明</span>}>
                {(published) => (
                  <time dateTime={published()}>
                    {formatMobilePreviewDate(published(), "ja-JP")}
                  </time>
                )}
              </Show>
            </MobilePreviewCard>
          )}
        </Show>
      </Show>
    </section>
  );
}
