import { createMemo, createRenderEffect, createSignal, createUniqueId, Show } from "solid-js";
import type { MobileSession } from "@takosjp/mobile-kit";
import { feedSessionIdentity } from "./feed-session.ts";
import { PostMedia } from "./post-media.tsx";
import { postContentRevision, postWarning, type MobilePostContent } from "./post-text.ts";

/** Disclosure is local to this card, connection, and exact content revision. */
export function PostContent(props: {
  post: MobilePostContent;
  session: MobileSession;
  isActive?: () => boolean;
  renderText?: (content: string) => string;
}) {
  const bodyId = createUniqueId();
  const [revealedFor, setRevealedFor] = createSignal<string>();
  const active = () => props.isActive?.() !== false;
  const warning = createMemo(() => postWarning(props.post.summary));
  // Internal lifetime key only; never render or persist session identity.
  const context = createMemo(() => JSON.stringify([
    feedSessionIdentity(props.session), postContentRevision(props.post),
  ]));
  let previous: string | undefined;
  createRenderEffect(() => {
    const next = context();
    // Always subscribe to activity, including the initial content revision.
    const currentActive = active();
    if (next !== previous || !currentActive) setRevealedFor(undefined);
    previous = next;
  });
  const visible = () => !warning() || active() && revealedFor() === context();
  return (
    <div class="post-content">
      <Show when={warning()}>
        {(text) => (
          <div class="post-warning" role="note">
            <p style={{ "overflow-wrap": "anywhere", "white-space": "pre-wrap" }}>{text()}</p>
            <button
              type="button"
              class="secondary"
              disabled={!active()}
              aria-expanded={visible()}
              aria-controls={bodyId}
              onClick={() => { if (active()) setRevealedFor(visible() ? undefined : context()); }}
            >
              {visible() ? "内容を隠す" : "内容を表示"}
            </button>
          </div>
        )}
      </Show>
      <div id={bodyId} role="region" aria-label="投稿の内容" hidden={!visible()}>
        <Show when={visible()}>
          <p style={{ "overflow-wrap": "anywhere", "white-space": "pre-wrap" }}>
            {props.renderText ? props.renderText(props.post.content) : props.post.content}
          </p>
          <PostMedia attachments={props.post.attachments} session={props.session} isActive={active} />
        </Show>
      </div>
    </div>
  );
}
