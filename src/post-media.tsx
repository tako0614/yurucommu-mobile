import {
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { MobileSession } from "@takosjp/mobile-kit";
import {
  createMobileMediaController,
  describeMobilePostMedia,
  type MobileMediaSource,
  type MobileMediaState,
} from "./post-media.ts";

export function PostMedia(props: {
  attachments: unknown;
  session: MobileSession;
  isActive?: () => boolean;
}) {
  const sources = createMemo(() =>
    describeMobilePostMedia(props.attachments, props.session.hostUrl),
  );
  return (
    <Show when={sources().length}>
      <ul class="post-media" aria-label="投稿の添付">
        <For each={sources()}>
          {(source) => (
            <MediaItem
              source={source}
              session={props.session}
              isActive={props.isActive}
            />
          )}
        </For>
      </ul>
    </Show>
  );
}

function MediaItem(props: {
  source: MobileMediaSource;
  session: MobileSession;
  isActive?: () => boolean;
}) {
  const [state, setState] = createSignal<MobileMediaState>({ phase: "idle" });
  const controller = createMobileMediaController({
    session: props.session,
    source: props.source,
    onChange: setState,
    isActive: props.isActive,
  });
  createRenderEffect(() => controller.update(props.session, props.source));
  onCleanup(() => controller.dispose());
  const label = () => (props.source.kind === "video" ? "動画" : "画像");
  return (
    <li>
      <Show
        when={props.source.kind !== "unavailable"}
        fallback={
          <p role="status">{props.source.label}をアプリで表示できません。</p>
        }
      >
        <Show
          when={state().phase === "ready" && state().url}
          fallback={
            <>
              <p>{props.source.label}</p>
              <Show when={state().error}>
                {(error) => <p role="alert">{error()}</p>}
              </Show>
              <button
                type="button"
                class="secondary"
                disabled={state().phase === "loading"}
                onClick={() => void controller.load()}
              >
                {state().phase === "loading"
                  ? "読み込み中…"
                  : state().phase === "error"
                    ? "添付を再試行"
                    : `${label()}を表示`}
              </button>
            </>
          }
        >
          {(url) => (
            <Show
              when={props.source.kind === "video"}
              fallback={
                <img
                  src={url()}
                  alt={props.source.label}
                  crossOrigin="anonymous"
                  referrerPolicy="no-referrer"
                  onError={(event) =>
                    controller.failed(event.currentTarget.src)
                  }
                />
              }
            >
              <video
                src={url()}
                controls
                playsinline
                preload="none"
                crossOrigin="anonymous"
                aria-label={props.source.label}
                onError={(event) => controller.failed(event.currentTarget.src)}
              />
            </Show>
          )}
        </Show>
      </Show>
    </li>
  );
}
