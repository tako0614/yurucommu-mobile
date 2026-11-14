import { createMemo, For, Show } from "solid-js";
import { confirmMobileAction, mobileTextRemaining } from "@takosjp/mobile-kit";
import {
  MobileComposeField,
  MobileComposeFooter,
  MobileComposeForm,
  MobileComposeSection,
  MobileSegmentedControl,
} from "@takosjp/mobile-kit/solid";
import {
  allowedMimeTypes,
  maxImageFileSize,
  maxVideoFileSize,
} from "@takosjp/yurucommu-api";
import {
  MAX_MOBILE_ATTACHMENTS,
  type createFeedController,
  type FeedState,
} from "./feed-controller.ts";

// The feed and reply share one product-owned composer and upload lifecycle.
export function PostComposer(props: {
  controller: ReturnType<typeof createFeedController>;
  state: FeedState;
  reply?: boolean;
  community?: boolean;
  authorMention?: string;
  chooseReplyAudience?: boolean;
}) {
  const content = () => props.state.content;
  const visibility = () => props.state.visibility;
  const sending = () => props.state.sending;
  const canPost = () => props.state.canSubmit;
  const recoveryBusy = () => props.state.recovery?.reviewingInvalid || props.state.recovery?.discardingInvalid || props.state.recovery?.discardPending;
  const attachmentIds = createMemo(() =>
    props.state.attachments.map((item) => item.id),
  );
  return (
    <MobileComposeSection title={props.reply ? "返信する" : "投稿する"}>
      <Show when={props.state.recovery}>{recovery => <>
        <Show when={recovery().loading || recovery().saving}><p role="status">{recovery().loading ? "保存した投稿下書きを確認中…" : "投稿下書きを保存中…"}</p></Show>
        <Show when={recovery().error}><div role="alert"><p>{recovery().error}</p>
          <button type="button" class="text-button" disabled={recovery().loading || recovery().saving || recovery().reviewingInvalid || recovery().discardingInvalid || recovery().checkingOutcome}
            onClick={() => void props.controller.flushRecovery()}>投稿下書きの確認・保存を再試行</button>
        </div></Show>
        <Show when={recovery().reviewingInvalid}><p role="status">下書きの保存範囲と破損内容を確認しています…</p></Show>
        <Show when={recovery().discardingInvalid}><p role="status">破損した下書き保存を破棄しています…</p></Show>
        <Show when={recovery().discardPending && recovery().checkingOutcome}><p role="status">破棄後の保存先と現在の投稿結果を確認しています…</p></Show>
        <Show when={recovery().canReviewInvalid}>
          <button type="button" class="text-button" onClick={() => void props.controller.reviewInvalidRecovery()}>破損した投稿下書きを確認</button>
        </Show>
        <Show when={recovery().invalidReview}>
          <div role="group" aria-label="破損した投稿下書きの破棄確認">
            <p>このアカウント・本人・接続先の{props.reply ? "この返信先・画面の" : "ホームの"}壊れた下書き保存だけを破棄し、現在の投稿結果を確認します。読み出せない保存済みの本文・添付情報・元の投稿結果不明の記録は元に戻せません。</p>
            <p>現在の画面の入力・添付・未確認の元投稿は保持します。この操作だけでは投稿や再送、配達の確定は行いません。</p>
            <button type="button" class="text-button" onClick={() => void props.controller.discardInvalidRecovery()}>この下書きの壊れた保存を破棄</button>
            <button type="button" class="text-button" onClick={() => props.controller.cancelInvalidRecoveryReview()}>破棄せず戻る</button>
          </div>
        </Show>
        <Show when={recovery().intent}>{intent => <div role="status">
          <p>{props.reply ? "元の返信結果は未確認です。復元だけでは再送しません。" : "元の投稿結果は未確認です。復元だけでは再送しません。"}</p>
          <p style={{ "white-space": "pre-wrap" }}>{intent().content}</p>
          <p>元の公開範囲: {intent().visibility}</p>
          <Show when={intent().replyTo}>{target => <><p>元の返信先: {target().apId}</p><p>元のコミュニティ: {target().communityApId ?? "なし"}</p></>}</Show>
          <For each={intent().media}>{media => <p>{media.name}</p>}</For>
          <button type="button" class="text-button" disabled={recovery().checkingOutcome || props.state.sending || recovery().reviewingInvalid || recovery().discardingInvalid || recovery().invalidReview}
            onClick={() => void props.controller.reviewRecoveryOutcome()}>{props.reply ? "返信一覧で結果を確認" : "フィードで投稿結果を確認"}</button>
          <button type="button" class="text-button" disabled={!recovery().canConfirmReview}
            onClick={() => void props.controller.confirmRecoveryReview()}>元の内容を確認した・次の投稿を許可</button>
          <small>この操作は配達の確定ではなく、自動再送もしません。</small>
        </div>}</Show>
      </>}</Show>
      <Show when={props.state.replyContextChanged}><div role="alert">
        <p>保存時と返信先の公開範囲・コミュニティが変わりました。下書きと元の未確認結果は保持しています。</p>
        <button type="button" class="text-button" disabled={props.state.sending || props.state.recovery?.saving}
          onClick={() => void props.controller.confirmReplyContext()}>現在の返信先設定で下書きを続ける</button>
      </div></Show>
      <MobileComposeForm
        onSubmit={(event) => {
          event.preventDefault();
          void props.controller.submit();
        }}
      >
        <MobileComposeField
          label={props.reply ? "この投稿に返信" : "いまどうしてる？"}
        >
          <textarea
            maxlength={500}
            disabled={!!props.state.recovery && !props.state.recovery.ready}
            value={content()}
            placeholder={props.reply ? "返信を書く" : "近況をシェア"}
            onInput={(event) =>
              props.controller.setDraft(event.currentTarget.value)
            }
          />
        </MobileComposeField>
        <MobileComposeField label="画像・動画を添付">
          <span
            class="composer-file-picker"
            classList={{
              "is-disabled":
                props.state.attachments.length >= MAX_MOBILE_ATTACHMENTS,
            }}
          >
            <span aria-hidden="true">画像・動画を選ぶ</span>
            <input
              type="file"
              multiple
              aria-label="画像・動画を添付"
              accept={allowedMimeTypes.join(",")}
              disabled={
                props.state.attachments.length >= MAX_MOBILE_ATTACHMENTS || (!!props.state.recovery && !props.state.recovery.ready) || recoveryBusy()
              }
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                void props.controller.addFiles(files);
              }}
            />
          </span>
        </MobileComposeField>
        <p class="composer-attachment-help">
          本文と一緒に投稿します。添付 {props.state.attachments.length}/
          {MAX_MOBILE_ATTACHMENTS}件・画像{maxImageFileSize / 1024 / 1024}
          MB／動画{maxVideoFileSize / 1024 / 1024}MBまで
        </p>
        <Show when={props.state.attachmentError}>
          {(message) => <p role="alert">{message()}</p>}
        </Show>
        <Show when={attachmentIds().length}>
          <ul class="composer-attachments" aria-label="添付ファイル">
            <For each={attachmentIds()}>
              {(id) => (
                <Show
                  when={props.state.attachments.find((item) => item.id === id)}
                >
                  {(item) => (
                    <li>
                      <Show when={item().previewUrl} fallback={<p>保存した添付: {item().name}</p>}>
                      <Show
                        when={item().contentType.startsWith("video/")}
                        fallback={
                          <img src={item().previewUrl} alt={item().name} />
                        }
                      >
                        <video
                          src={item().previewUrl}
                          controls
                          playsinline
                          preload="metadata"
                          aria-label={item().name}
                        />
                      </Show>
                      </Show>
                      <p>{item().name}</p>
                      <p role="status">
                        {
                          {
                            queued: "アップロード待ち",
                            uploading: "アップロード中",
                            ready: "アップロード済み",
                            error: "アップロード失敗",
                            reselect: "元のファイルを再選択",
                          }[item().phase]
                        }
                      </p>
                      <Show when={item().error}>
                        {(message) => <p role="alert">{message()}</p>}
                      </Show>
                      <div class="composer-attachment-actions">
                        <Show when={item().phase === "error" && !!item().previewUrl}>
                          <button
                            type="button"
                            class="secondary"
                            disabled={recoveryBusy()}
                            onClick={() =>
                              void props.controller.retryAttachment(id)
                            }
                          >
                            再アップロード
                          </button>
                        </Show>
                        <button
                          type="button"
                          class="text-button"
                          aria-label={`${item().name}を外す`}
                          onClick={() => props.controller.removeAttachment(id)}
                        >
                          外す
                        </button>
                      </div>
                    </li>
                  )}
                </Show>
              )}
            </For>
          </ul>
        </Show>
        <Show
          when={!props.reply}
          fallback={
            <div class="reply-audience" role="note">
              <p>
                返信の公開範囲:{" "}
                {
                  {
                    public: props.community ? "元のコミュニティ" : "公開",
                    unlisted: props.community ? "元のコミュニティ" : "ひかえめ",
                    followers: props.community
                      ? "あなたのフォロワー（元のコミュニティ内）"
                      : "あなたのフォロワー",
                    direct: "ダイレクト",
                  }[visibility()]
                }
              </p>
              <Show when={props.community}>
                <p>元の投稿と同じコミュニティへ返信します。</p>
              </Show>
              <Show when={props.chooseReplyAudience}>
                <p>
                  元の投稿とあなたのフォロワーは異なる場合があります。返信の公開先を選んでください。
                </p>
                <MobileSegmentedControl
                  ariaLabel="返信の公開先"
                  value={
                    props.state.replyAudienceNeedsChoice ? "" : visibility()
                  }
                  options={[
                    { value: "followers", label: "自分のフォロワー" },
                    { value: "direct", label: "ダイレクト" },
                  ]}
                  onChange={(value) => {
                    if (value === "followers" || value === "direct")
                      props.controller.setVisibility(value);
                  }}
                />
              </Show>
              <Show when={visibility() === "followers" && !props.community}>
                <p>
                  この返信はあなたのフォロワーに公開されます。元の投稿の公開先とは異なる場合があります。
                </p>
              </Show>
              <Show when={visibility() === "direct"}>
                <p>
                  宛先を本文の @ユーザー名
                  で指定してください。元の投稿者には自動で送られません。
                </p>
                <Show when={props.authorMention}>
                  <button
                    type="button"
                    class="text-button"
                    onClick={() =>
                      props.controller.setDraft(
                        `${props.authorMention} ${content()}`,
                      )
                    }
                  >
                    投稿者を宛先に追加
                  </button>
                </Show>
              </Show>
            </div>
          }
        >
          <MobileSegmentedControl
            ariaLabel="公開範囲"
            disabled={!!props.state.recovery && !props.state.recovery.ready}
            value={visibility()}
            options={[
              { value: "public", label: "公開" },
              { value: "unlisted", label: "ひかえめ" },
              { value: "followers", label: "フォロワー" },
            ]}
            onChange={(value) => props.controller.setVisibility(value)}
          />
        </Show>
        <MobileComposeFooter
          detail={`あと ${mobileTextRemaining(content(), 500)} 文字`}
        >
          <button
            class="text-button"
            type="button"
            disabled={!content() && !props.state.attachments.length}
            onClick={() => {
              if (
                confirmMobileAction({
                  message: props.reply
                    ? "入力中の返信を消しますか？"
                    : "入力中の投稿を消しますか？",
                })
              )
                props.controller.clearDraft();
            }}
          >
            クリア
          </button>
          <button class="primary" type="submit" disabled={!canPost()}>
            {sending() ? "送信中" : props.reply ? "返信を送信" : "投稿"}
          </button>
        </MobileComposeFooter>
      </MobileComposeForm>
      <Show when={props.state.error}>
        {(error) => <p role="alert">{error()}</p>}
      </Show>
      <Show when={props.state.status}>
        {(status) => <p role="status">{status()}</p>}
      </Show>
      <Show when={props.state.refreshError}>
        {(error) => <p role="alert">{error()}</p>}
      </Show>
    </MobileComposeSection>
  );
}
