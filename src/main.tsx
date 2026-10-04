import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import {
  appendUniqueMobileItemsById,
  appendUniqueMobileItemsByKey,
  canSubmitMobileText,
  confirmMobileAction,
  formatMobilePreviewDate,
  mobileTextRemaining,
} from "@takosjp/mobile-kit";
import {
  defineMobileHostActions,
  MobileComposeField,
  MobileComposeFooter,
  MobileComposeForm,
  MobileComposeSection,
  MobilePreviewCard,
  MobilePreviewList,
  MobilePreviewSection,
  MobileSegmentedControl,
  renderMobileClientApp,
  type MobileShellMetric,
} from "@takosjp/mobile-kit/solid";
import {
  createPost,
  loadHome,
  loadYurucommuMobileBookmarksPage,
  registerPush,
  unregisterPush,
  type YurucommuMobileHome,
} from "./api.ts";
import { createProductNativeBridge } from "./native.ts";
import { productAdapter } from "./product.ts";
import "./styles.css";

const metrics = [
  { label: "投稿", value: (home) => home?.posts.length },
  { label: "未読", value: (home) => home?.unread },
  { label: "フォロー", value: () => undefined },
] satisfies readonly MobileShellMetric<YurucommuMobileHome>[];

const actions = defineMobileHostActions<YurucommuMobileHome>([
  { label: "フィード", description: "すべての投稿を見る", path: "/" },
  { label: "ストーリー", description: "24時間の近況を見る", path: "/stories" },
  {
    label: "通知",
    description: "反応とフォローを見る",
    path: "/notifications",
  },
  {
    label: "プロフィール",
    description: "自分のプロフィールを開く",
    path: "/profile",
  },
]);

renderMobileClientApp<YurucommuMobileHome>({
  adapter: productAdapter,
  createNativeBridge: createProductNativeBridge,
  loadHome,
  registerPush,
  unregisterPush,
  sessionUnlock: {
    restoreMode: "if-available",
    prompt: {
      title: "Yurucommu",
      message: "セッションを開きます",
      allowDeviceCredential: true,
    },
  },
  homeLabel: "フィード",
  copy: {
    eyebrow: "YOUR PLACE, YOUR PEOPLE",
    // Mirror of `yurucommu/public/icons/yurucommu.svg`, the product-owned
    // canonical mark. `brandMark` stays as the fallback glyph.
    brandLogoUrl: "/brand/yurucommu.svg",
    brandMark: "ゆ",
    onboardingTitle: "あなたの居場所につながろう",
    summary: "自分のサーバーで、みんなとゆるくつながる。",
    // Mirror of takosumi/dashboard/public/tako.png, the canonical Takosumi
    // mark named by docs/reference/design-language.md, instead of a "T".
    hostCenterIconUrl: "/brand/takosumi.png",
    takosumiActionLabel: "Takosumiで始める",
    takosumiActionDescription: "Takosumiで自分用に作ったサーバーに接続",
    manualActionLabel: "サーバーを自分で入力",
    manualActionDescription: "CloudflareやセルフホストのURLを使用",
    connectLabel: "サーバーURL",
    qrActionLabel: "接続QRを読み取る",
    discoveredHeading: "サーバーが見つかりました",
    homeFallbackTitle: "フィード",
    refreshLabel: "更新",
    homeTitle: (home) => home?.actor.name ?? home?.actor.preferred_username,
    metricsLabel: "フィード概要",
    shortcutsLabel: "メニュー",
  },
  metrics,
  hostActions: actions,
  renderHomeExtra: ({ home, session, refreshHome }) => (
    <>
      <Feed
        home={home}
        onPost={(content, visibility) => createPost(session, content, visibility)}
        refreshHome={refreshHome}
      />
      <BookmarksPreview
        load={() => loadYurucommuMobileBookmarksPage(session)}
      />
    </>
  ),
});

type Visibility = "public" | "unlisted" | "followers";

function Feed(props: {
  home?: YurucommuMobileHome;
  onPost: (content: string, visibility: Visibility) => Promise<void>;
  refreshHome: () => Promise<void>;
}) {
  const [content, setContent] = createSignal("");
  const [visibility, setVisibility] = createSignal<Visibility>("public");
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string>();
  const [refreshError, setRefreshError] = createSignal<string>();
  const canPost = () =>
    canSubmitMobileText({
      value: content(),
      maxLength: 500,
      disabled: sending(),
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
          onSubmit={async (event) => {
            event.preventDefault();
            if (!canPost()) return;
            setSending(true);
            setSendError(undefined);
            setRefreshError(undefined);
            let accepted = false;
            try {
              await props.onPost(content(), visibility());
              accepted = true;
              setContent("");
            } catch (error) {
              setSendError(
                error instanceof Error
                  ? error.message
                  : "投稿の結果を確認できませんでした。再送する前にフィードを確認してください。",
              );
            } finally {
              setSending(false);
            }
            if (accepted) {
              try {
                await props.refreshHome();
              } catch {
                setRefreshError("投稿は送信済みです。フィードを更新できませんでした。");
              }
            }
          }}
        >
          <MobileComposeField label="いまどうしてる？">
            <textarea
              maxlength={500}
              value={content()}
              placeholder="近況をシェア"
              onInput={(event) => setContent(event.currentTarget.value)}
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
            onChange={setVisibility}
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
                  setContent("");
              }}
            >
              クリア
            </button>
            <button class="primary" type="submit" disabled={!canPost()}>
              {sending() ? "送信中" : "投稿"}
            </button>
          </MobileComposeFooter>
        </MobileComposeForm>
        <Show when={sendError()}>
          {(error) => <p role="alert">{error()}</p>}
        </Show>
        <Show when={refreshError()}>
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

function BookmarksPreview(props: {
  load: () => Promise<import("./api.ts").MobilePost[]>;
}) {
  const [posts, setPosts] = createSignal<
    readonly import("./api.ts").MobilePost[]
  >([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  let active = true;
  let request = 0;
  onCleanup(() => {
    active = false;
    request += 1;
  });
  async function refresh() {
    const current = ++request;
    setLoading(true);
    setError(undefined);
    setPosts([]);
    try {
      const next = await props.load();
      if (!active || current !== request) return;
      const withIds = next.map((post) => ({ ...post, id: post.ap_id }));
      setPosts(appendUniqueMobileItemsById([], withIds));
    } catch (error) {
      if (active && current === request) {
        setError(
          error instanceof Error
            ? error.message
            : "保存した投稿を取得できませんでした。",
        );
      }
    } finally {
      if (active && current === request) setLoading(false);
    }
  }
  createEffect(() => {
    void refresh();
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
