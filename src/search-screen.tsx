import { createRenderEffect, createUniqueId, For, Show } from "solid-js";
import type { MobileSession } from "@takosjp/mobile-kit";
import { MobilePreviewCard, MobilePreviewList, MobilePreviewSection } from "@takosjp/mobile-kit/solid";
import { PostContent } from "./post-content.tsx";
import { postText } from "./post-text.ts";
import type { createSearchController, MobileSearchState } from "./search-controller.ts";

export function SearchScreen(props: {
  session: MobileSession;
  state: MobileSearchState;
  controller: ReturnType<typeof createSearchController>;
  visible: boolean;
  isActive: () => boolean;
  onClose: () => void;
  onOpenPost: (id: string, trigger: HTMLButtonElement) => void;
  onOpenProfile: (id: string, trigger: HTMLButtonElement) => void;
}) {
  const id = createUniqueId();
  createRenderEffect(() => { if (!props.visible) props.controller.pause(); });
  const busy = () => props.state.loading || props.state.loadingMore;
  const count = () => props.state.resultKind === "posts" ? props.state.posts.length : props.state.actors.length;
  return (
    <section hidden={!props.visible} aria-label="投稿・ユーザーを検索">
      <button type="button" class="text-button" onClick={() => props.onClose()}>フィードへ戻る</button>
      <h2>投稿・ユーザーを検索</h2>
      <p>接続中のサーバーが検索できる投稿とユーザーを探します。</p>
      <form onSubmit={(event) => { event.preventDefault(); void props.controller.search(); }}>
        <label for={`${id}-query`}>検索語</label>
        <input id={`${id}-query`} type="search" value={props.state.query}
          onInput={(event) => props.controller.setQuery(event.currentTarget.value)} />
        <label for={`${id}-kind`}>検索対象</label>
        <select id={`${id}-kind`} value={props.state.kind}
          onChange={(event) => props.controller.setKind(event.currentTarget.value === "actors" ? "actors" : "posts")}>
          <option value="posts">投稿</option><option value="actors">ユーザー</option>
        </select>
        <button type="submit" disabled={busy() || !props.state.query.trim()}>検索</button>
      </form>
      <Show when={props.state.loading}><p role="status">検索中…</p></Show>
      <Show when={props.state.error}>
        <p role="alert">{props.state.error}</p>
        <Show when={props.state.canRetry}>
          <button type="button" class="secondary" disabled={busy()} onClick={() => void props.controller.retry()}>検索を再試行</button>
        </Show>
      </Show>
      <Show when={props.state.loaded}>
        <MobilePreviewSection title={`「${props.state.resultQuery}」の${props.state.resultKind === "posts" ? "投稿" : "ユーザー"}`} detail={`${count()}件`}>
          <Show when={count()} fallback={<p class="empty">一致する{props.state.resultKind === "posts" ? "投稿" : "ユーザー"}はありません。</p>}>
            <MobilePreviewList>
              <For each={props.state.posts}>{post => (
                <li><MobilePreviewCard class="feed-card">
                  <button type="button" class="text-button" data-profile-id={post.author.ap_id}
                    onClick={event => props.onOpenProfile(post.author.ap_id, event.currentTarget)}>
                    {post.author.name || post.author.preferred_username || post.author.ap_id}
                  </button>
                  <PostContent session={props.session} post={post} renderText={postText} isActive={() => props.visible && props.isActive()} />
                  <button type="button" class="text-button" data-post-id={post.ap_id} data-post-surface="search"
                    aria-label={`${post.author.name || post.author.preferred_username || "投稿者"}の投稿を開く`}
                    onClick={event => props.onOpenPost(post.ap_id, event.currentTarget)}>投稿を開く</button>
                </MobilePreviewCard></li>
              )}</For>
              <For each={props.state.actors}>{actor => (
                <li><MobilePreviewCard>
                  <button type="button" class="text-button" data-profile-id={actor.ap_id}
                    onClick={event => props.onOpenProfile(actor.ap_id, event.currentTarget)}>
                    {actor.name || actor.preferred_username || actor.ap_id}
                  </button>
                  <p>@{actor.preferred_username}</p>
                </MobilePreviewCard></li>
              )}</For>
            </MobilePreviewList>
          </Show>
        </MobilePreviewSection>
        <Show when={props.state.hasMore}>
          <Show when={props.state.nextOffset <= 10000} fallback={<p role="status">検索件数の上限に達しました。検索語を絞ってください。</p>}>
            <button type="button" class="secondary" disabled={!props.state.canLoadMore}
              onClick={() => void props.controller.loadMore()}>{props.state.loadingMore ? "読み込み中…" : "続きを読み込む"}</button>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
