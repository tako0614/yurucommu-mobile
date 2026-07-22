import { createEffect, createSignal, For, Show } from "solid-js";
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
    summary: "ゆるくつながる、自分たちのコミュニティ。",
    // Mirror of takosumi/dashboard/public/tako.png, the canonical Takosumi
    // mark named by docs/reference/design-language.md, instead of a "T".
    hostCenterIconUrl: "/brand/takosumi.png",
    takosumiActionLabel: "Takosumiで始める",
    takosumiActionDescription: "Takosumiで作ったコミュニティに接続",
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
  renderHomeExtra: ({ home, session, refreshHome, openHostRoute }) => (
    <>
      <Feed
        home={home}
        onPost={async (content, visibility) => {
          await createPost(session, content, visibility);
          await refreshHome();
        }}
      />
      <BookmarksPreview
        load={() => loadYurucommuMobileBookmarksPage(session)}
        openHostRoute={openHostRoute}
      />
    </>
  ),
});

type Visibility = "public" | "unlisted" | "followers";

function Feed(props: {
  home?: YurucommuMobileHome;
  onPost: (content: string, visibility: Visibility) => Promise<void>;
}) {
  const [content, setContent] = createSignal("");
  const [visibility, setVisibility] = createSignal<Visibility>("public");
  const [sending, setSending] = createSignal(false);
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
            try {
              await props.onPost(content(), visibility());
              setContent("");
            } finally {
              setSending(false);
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
      </MobileComposeSection>
      <MobilePreviewSection title="フィード" detail={`${posts().length}件`}>
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
                      <time>
                        {formatMobilePreviewDate(post.published, "ja-JP")}
                      </time>
                    </footer>
                  </MobilePreviewCard>
                </li>
              )}
            </For>
          </MobilePreviewList>
        </Show>
      </MobilePreviewSection>
    </div>
  );
}

function BookmarksPreview(props: {
  load: () => Promise<import("./api.ts").MobilePost[]>;
  openHostRoute: (path: string) => Promise<void>;
}) {
  const [posts, setPosts] = createSignal<
    readonly import("./api.ts").MobilePost[]
  >([]);
  createEffect(() => {
    void props.load().then((next) => {
      const withIds = next.map((post) => ({ ...post, id: post.ap_id }));
      const merged = appendUniqueMobileItemsById([], withIds);
      setPosts(merged);
    });
  });
  return (
    <MobilePreviewSection
      title="保存した投稿"
      actions={
        <button
          type="button"
          class="text-button"
          onClick={() => void props.openHostRoute("/bookmarks")}
        >
          すべて見る
        </button>
      }
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
    </MobilePreviewSection>
  );
}
