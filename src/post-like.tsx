import { createRenderEffect, createSignal, onCleanup, Show } from "solid-js";
import type { MobileSession } from "@takosjp/mobile-kit";
import { feedSessionIdentity } from "./feed-session.ts";
import {
  type PostLikeStore,
  type MobileLikePost,
  type MobileLikeState,
} from "./post-like-controller.ts";

/** Visible cards share one account/post operation; the server owns its state. */
export function PostLike(props: {
  session: MobileSession;
  post: MobileLikePost;
  store: PostLikeStore;
  isActive?: () => boolean;
}) {
  const [state, setState] = createSignal<MobileLikeState>();
  let controller: ReturnType<PostLikeStore["acquire"]>;
  createRenderEffect(() => {
    const post = props.post;
    if (!controller || controller.apId !== post.ap_id) {
      controller?.dispose();
      controller = props.store.acquire(post, setState);
      controller.setActive(props.isActive?.() !== false);
    } else controller.updatePost(post);
  });
  createRenderEffect(() => controller.setActive(props.isActive?.() !== false));
  onCleanup(() => controller.dispose());
  const current = () => state()!;
  let primary: HTMLButtonElement | undefined;
  let recovery: HTMLButtonElement | undefined;
  const focusScope = () =>
    JSON.stringify([
      feedSessionIdentity(props.session),
      props.session.apiBaseUrl,
      props.post.ap_id,
    ]);
  async function run(readOnly: boolean) {
    const origin = readOnly ? recovery : primary;
    const restore = document.activeElement === origin;
    const scope = focusScope();
    if (readOnly) await controller.reload();
    else await controller.toggle();
    // Native disabled controls can lose keyboard focus while pending. Restore
    // only an otherwise unclaimed focus in this exact live card/account.
    if (
      !restore ||
      props.isActive?.() === false ||
      scope !== focusScope() ||
      document.activeElement !== document.body
    )
      return;
    const target =
      current().needsReload || current().liked === null ? recovery : primary;
    if (target?.isConnected && !target.disabled) target.focus();
  }
  return (
    <div class="post-like" aria-label="いいねの操作">
      <Show
        when={current().liked !== null}
        fallback={<span>♡ {current().count}（状態未確認）</span>}
      >
        <button
          ref={primary}
          type="button"
          class="text-button"
          aria-label={current().liked ? "いいねを取り消す" : "いいね"}
          aria-pressed={current().liked === true}
          disabled={!current().canToggle}
          onClick={() => void run(false)}
        >
          {current().busy ? "確認中…" : current().liked ? "♥" : "♡"}{" "}
          {current().count}
        </button>
      </Show>
      <Show when={current().needsReload || current().liked === null}>
        <button
          ref={recovery}
          type="button"
          class="text-button"
          disabled={current().busy}
          onClick={() => void run(true)}
        >
          いいねの状態を確認
        </button>
      </Show>
      <Show when={current().error}>
        <p role="alert">{current().error}</p>
      </Show>
      <Show when={current().status}>
        <p role="status">{current().status}</p>
      </Show>
      <Show when={current().refreshError}>
        <p role="alert">{current().refreshError}</p>
      </Show>
    </div>
  );
}
