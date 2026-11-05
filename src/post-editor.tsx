import { createEffect, createUniqueId, on, Show } from "solid-js";
import type { MobilePostEditState, PostEditController } from "./post-edit-controller.ts";
import { POST_EDIT_CONTENT_LIMIT, POST_EDIT_SUMMARY_LIMIT } from "./post-edit-api.ts";
import { MobileComposeField, MobileComposeForm } from "@takosjp/mobile-kit/solid";
export function PostEditor(props: {
    state: MobilePostEditState;
    controller: PostEditController;
    onClose: () => void;
}) {
    let input: HTMLTextAreaElement | undefined;
    const id = createUniqueId();
    createEffect(on(() => props.state.loading, (loading, previous) => {
        if (!loading && (previous || previous === undefined))
            queueMicrotask(() => {
                if (props.state.visible && input?.isConnected && !input.disabled)
                    input.focus();
            });
    }));
    return (<section aria-label="投稿を編集" class="native-post-editor">
      <h3>投稿を編集</h3>
      <p>本文と内容警告を変更できます。公開範囲・宛先・添付は変更しません。</p>
      <Show when={props.state.loading}><p role="status">現在の投稿を確認しています…</p></Show>
      <MobileComposeForm onSubmit={(event) => { event.preventDefault(); void props.controller.save(); }}>
        <MobileComposeField label="本文">
          <textarea ref={input} value={props.state.draft.content} maxlength={POST_EDIT_CONTENT_LIMIT} aria-describedby={`${id}-content`} disabled={props.state.loading || !props.state.base} onInput={(event) => props.controller.setField("content", event.currentTarget.value)}/>
        </MobileComposeField>
        <p id={`${id}-content`}>本文 {props.state.draft.content.trim().length}/{POST_EDIT_CONTENT_LIMIT}文字</p>
        <MobileComposeField label="内容警告（任意）">
          <input type="text" value={props.state.draft.summary} maxlength={POST_EDIT_SUMMARY_LIMIT} aria-describedby={`${id}-summary`} disabled={props.state.loading || !props.state.base} onInput={(event) => props.controller.setField("summary", event.currentTarget.value)}/>
        </MobileComposeField>
        <p id={`${id}-summary`}>内容警告 {props.state.draft.summary.trim().length}/{POST_EDIT_SUMMARY_LIMIT}文字。外す場合は空欄にします。</p>
        <Show when={props.state.error}><p role="alert">{props.state.error}</p></Show>
        <Show when={props.state.status}><p role="status">{props.state.status}</p></Show>
        <Show when={props.state.refreshError}><p role="alert">{props.state.refreshError}</p></Show>
        <button type="submit" class="primary" disabled={!props.state.canSave}>{props.state.saving ? "保存中…" : "投稿の変更を保存"}</button>
        <button type="button" class="text-button" disabled={props.state.saving} onClick={props.onClose}>編集を閉じる</button>
      </MobileComposeForm>
      <p>入力は同じ投稿を開き直したときも保持します。別の投稿へ移る際は、未保存の入力を閉じるか確認します。</p>
      <button type="button" class="text-button" disabled={props.state.loading || props.state.saving} onClick={() => void props.controller.reload()}>現在の保存状態を確認</button>
      <button type="button" class="text-button" disabled={props.state.loading || props.state.saving} onClick={() => void props.controller.discardAndReload()}>入力を破棄して再読込</button>
      <Show when={props.state.base}>
        {(base) => <details><summary>現在の保存内容</summary><pre style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>{base().content}</pre><p>内容警告：{base().summary || "なし"}</p></details>}
      </Show>
    </section>);
}
