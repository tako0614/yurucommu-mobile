import {
  createEffect, createMemo, createRenderEffect, createSignal,
  For, onCleanup, Show, untrack,
} from "solid-js";
import {
  appendUniqueMobileItemsById, appendUniqueMobileItemsByKey,
  canSubmitMobileText, confirmMobileAction, formatMobilePreviewDate,
  mobileTextRemaining, type MobileSession,
} from "@takosjp/mobile-kit";
import {
  MobileComposeField, MobileComposeFooter, MobileComposeForm,
  MobileComposeSection, MobilePreviewCard, MobilePreviewList,
  MobilePreviewSection, MobileSegmentedControl,
} from "@takosjp/mobile-kit/solid";
import { loadYurucommuMobileBookmarksPage, type YurucommuMobileHome } from "./api.ts";
import { createFeedController, type FeedState } from "./feed-controller.ts";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";

export function Feed(props: {
  home?: YurucommuMobileHome;
  session: MobileSession;
  isActive?: () => boolean;
  refreshHome: () => Promise<void>;
}) {
  const [state, setState] = createSignal<FeedState>({
    content: "", visibility: "public", sending: false,
    error: "", status: "", refreshError: "",
  });
  const controller = createFeedController({
    session: props.session,
    refreshHome: () => props.refreshHome(),
    isActive: () => props.isActive?.() !== false,
    onChange: setState,
  });
  createRenderEffect(() => controller.updateSession(props.session));
  onCleanup(() => controller.dispose());
  const content = () => state().content;
  const visibility = () => state().visibility;
  const sending = () => state().sending;
  const canPost = () => canSubmitMobileText({
    value: content(), maxLength: 500, disabled: sending(),
  });
  const posts = () =>
    appendUniqueMobileItemsByKey(
      [],
      props.home?.posts ?? [],
      (post) => post.ap_id,
    );
  return (
    <div class="mobile-feed">
      <MobileComposeSection title="投稿する">
        <MobileComposeForm
          onSubmit={(event) => {
            event.preventDefault();
            void controller.submit();
          }}
        >
          <MobileComposeField label="いまどうしてる？">
            <textarea
              maxlength={500}
              value={content()}
              placeholder="近況をシェア"
              onInput={(event) => controller.setDraft(event.currentTarget.value)}
            />
          </MobileComposeField>
          <MobileSegmentedControl
            ariaLabel="公開範囲"
            value={visibility()}
            options={[
              { value: "public", label: "公開" },
              { value: "unlisted", label: "ひかえめ" },
              { value: "followers", label: "フォロワー" },
            ]}
            onChange={(value) => controller.setVisibility(value)}
          />
          <MobileComposeFooter
            detail={`あと ${mobileTextRemaining(content(), 500)} 文字`}
          >
            <button
              class="text-button"
              type="button"
              disabled={!content()}
              onClick={() => {
                if (
                  confirmMobileAction({ message: "入力中の投稿を消しますか？" })
                )
                  controller.clearDraft();
              }}
            >
              クリア
            </button>
            <button class="primary" type="submit" disabled={!canPost()}>
              {sending() ? "送信中" : "投稿"}
            </button>
          </MobileComposeFooter>
        </MobileComposeForm>
        <Show when={state().error}>
          {(error) => <p role="alert">{error()}</p>}
        </Show>
        <Show when={state().status}>
          {(status) => <p role="status">{status()}</p>}
        </Show>
        <Show when={state().refreshError}>
          {(error) => <p role="alert">{error()}</p>}
        </Show>
      </MobileComposeSection>
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
                      <footer>
                        <span>♡ {post.like_count}</span>
                        <span>返信 {post.reply_count}</span>
                        <Show when={post.published}>
                          {(published) => (
                            <time>{formatMobilePreviewDate(published(), "ja-JP")}</time>
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
  isActive?: () => boolean;
}) {
  const [posts, setPosts] = createSignal<
    readonly import("./api.ts").MobilePost[]
  >([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  let active = true;
  let request = 0;
  const sessionKey = createMemo(() => feedSessionIdentity(props.session));
  const currentSession = () => untrack(() => snapshotFeedSession(props.session));
  const live = (current: number, key: string) =>
    active && props.isActive?.() !== false && current === request &&
    key === feedSessionIdentity(props.session);
  onCleanup(() => {
    active = false;
    request += 1;
  });
  async function refresh(requestSession = currentSession(), key = feedSessionIdentity(requestSession)) {
    const current = ++request;
    setLoading(true);
    setError(undefined);
    setPosts([]);
    try {
      const next = await loadYurucommuMobileBookmarksPage(requestSession);
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
      if (live(current, key)) setLoading(false);
    }
  }
  createEffect(() => {
    const key = sessionKey();
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
                    <MobilePreviewCard>
                      <strong>
                        {post.author.name ?? post.author.preferred_username}
                      </strong>
                      <p>{post.content}</p>
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
