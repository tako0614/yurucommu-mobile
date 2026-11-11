import { createEffect, For, Index, Show } from "solid-js";
import type { MobileSession } from "@takosjp/mobile-kit";
import type { createProfileEditController } from "./profile-edit-controller.ts";
import { PostMedia } from "./post-media.tsx";
import { profileFormKeys, type MobileProfileForm } from "./profile-edit-api.ts";
export function ProfileEdit(props: {
  controller: ReturnType<typeof createProfileEditController>;
  revision: number;
  session: MobileSession;
  isActive: () => boolean;
  onBack: () => void;
}) {
  const state = () => {
    props.revision;
    return props.controller.getState();
  };
  const labels: Record<keyof MobileProfileForm, string> = { name: "表示名", summary: "自己紹介", icon_url: "アバターURL", header_url: "ヘッダー画像URL", is_private: "承認制フォロー", fields: "追加項目" };
  const display = (value: MobileProfileForm[keyof MobileProfileForm] | undefined) => typeof value === "boolean" ? value ? "有効" : "無効"
    : Array.isArray(value) ? value.map(row => row.name + ": " + row.value).join("\n") : value ?? "";
  let heading: HTMLHeadingElement | undefined,
    name: HTMLInputElement | undefined,
    save: HTMLButtonElement | undefined,
    reload: HTMLButtonElement | undefined,
    rows: HTMLDivElement | undefined,
    add: HTMLButtonElement | undefined;
  createEffect(() => {
    const visible = state().visible,
      loaded = state().loaded;
    if (visible)
      queueMicrotask(() => {
        if (!state().visible || !props.isActive()) return;
        if (
          document.activeElement === document.body ||
          document.activeElement === heading
        )
          (loaded ? name : heading)?.focus();
      });
  });
  async function run(readOnly: boolean) {
    const origin = readOnly ? reload : save,
      restore = document.activeElement === origin;
    const owned = await (readOnly
      ? props.controller.reload()
      : props.controller.save());
    if (
      !owned ||
      !restore ||
      !state().visible ||
      !props.isActive() ||
      document.activeElement !== document.body
    )
      return;
    const target = state().needsReload ? reload : save;
    if (target?.isConnected && !target.disabled) target.focus();
  }
  function focusRow(index: number) {
    queueMicrotask(() => {
      if (!state().visible || !props.isActive()) return;
      const all = rows?.children,
        target =
          all?.[Math.min(index, (all?.length ?? 0) - 1)]?.querySelector(
            "input",
          ) ?? add;
      target?.focus();
    });
  }
  return (
    <Show when={state().visible}>
      <section
        class="profile-editor"
        aria-label="プロフィールを編集"
        style={{ "overflow-wrap": "anywhere" }}
      >
        <h3 ref={heading} tabIndex={-1}>
          プロフィールを編集
        </h3>
        <p>
          変更は「保存」で反映します。戻っても入力はこのアカウントのまま保持します。
        </p>
        <button type="button" class="text-button" onClick={props.onBack}>
          プロフィールへ戻る
        </button>
        <Show when={state().loading}>
          <p role="status">現在のプロフィールを確認中…</p>
        </Show>
        <Show when={state().error}>
          <p role="alert">{state().error}</p>
        </Show>
        <Show when={state().recovery}>{recovery => <>
          <Show when={recovery().saving}><p role="status">プロフィール入力を安全に保存中…</p></Show>
          <Show when={recovery().error}><div role="alert"><p>{recovery().error}</p>
            <button type="button" class="text-button" disabled={state().busy || recovery().saving}
              onClick={() => void props.controller.flushRecovery()}>プロフィール入力の確認・保存を再試行</button>
          </div></Show>
          <Show when={recovery().attempted || recovery().conflicts.length}><div role="status">
            <p>未確認のプロフィール変更、または保存時から変わった項目があります。入力を保持し、自動再送しません。</p>
            <details><summary>元の変更と現在の保存状態</summary>
              <For each={profileFormKeys.filter(key => key in (recovery().attempted?.patch ?? {}) || recovery().conflicts.includes(key))}>{key => <div>
                <p>{labels[key]}</p>
                <Show when={key in (recovery().attempted?.patch ?? {})}><p style={{ "white-space": "pre-wrap" }}>元の変更: {display(recovery().attempted?.patch[key])}</p></Show>
                <p style={{ "white-space": "pre-wrap" }}>現在の保存状態: {display(recovery().current?.[key])}</p>
              </div>}</For>
            </details>
            <p>下の「現在の保存状態を確認」から正規の状態を読み、元の変更と照合してください。</p>
            <button type="button" class="text-button" disabled={!recovery().canConfirmReview}
              onClick={() => void props.controller.confirmRecoveryReview()}>元の変更と現在の状態を確認した・編集を続ける</button>
          </div></Show>
        </>}</Show>
        <Show when={state().loaded}>
          <form
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                (e.isComposing || e.keyCode === 229)
              )
                e.preventDefault();
            }}
            onSubmit={(e) => {
              e.preventDefault();
              void run(false);
            }}
          >
            <label>
              表示名
              <input
                ref={name}
                value={state().draft.name}
                maxLength={50}
                onInput={(e) =>
                  props.controller.setField("name", e.currentTarget.value)
                }
              />
            </label>
            <label>
              自己紹介
              <textarea
                value={state().draft.summary}
                maxLength={500}
                onInput={(e) =>
                  props.controller.setField("summary", e.currentTarget.value)
                }
              />
            </label>
            <label class="profile-editor-private">
              <input
                type="checkbox"
                checked={state().draft.is_private}
                onChange={(e) =>
                  props.controller.setField(
                    "is_private",
                    e.currentTarget.checked,
                  )
                }
              />
              フォローを承認制にする
            </label>
            <Index
              each={[
                { key: "icon_url" as const, label: "アバター" },
                { key: "header_url" as const, label: "ヘッダー画像" },
              ]}
            >
              {(entry) => {
                const key = entry().key,
                  upload = () => state().uploads[key];
                return (
                  <fieldset>
                    <legend>{entry().label}</legend>
                    <label class="composer-file-picker">
                      {entry().label}を選択
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp"
                        disabled={state().loading || state().saving}
                        onChange={(e) => {
                          const file = e.currentTarget.files?.[0];
                          e.currentTarget.value = "";
                          if (file) void props.controller.pickImage(key, file);
                        }}
                      />
                    </label>
                    <Show when={upload()}>
                      {(value) => (
                        <div>
                          <p role="status">
                            {value().name}：
                            {value().phase === "uploading"
                              ? "アップロード中…"
                              : value().phase === "ready"
                                ? value().saved
                                  ? "プロフィールに保存済み"
                                  : "アップロード済み・プロフィールは保存が必要です"
                                : value().phase === "reselect" ? "元の画像を再選択してください" : "アップロード未完了"}
                          </p>
                          <Show when={value().error}>
                            <p role="alert">{value().error}</p>
                            <Show when={value().phase !== "reselect"}><button
                              type="button"
                              class="text-button"
                              disabled={state().loading || state().saving}
                              onClick={() =>
                                void props.controller.retryImage(key)
                              }
                            >
                              {entry().label}を再アップロード
                            </button></Show>
                          </Show>
                          <button
                            type="button"
                            class="text-button"
                            disabled={state().saving || state().loading}
                            onClick={() => {
                              props.controller.restoreImage(key);
                            }}
                          >
                            画像の選択を取り消す
                          </button>
                        </div>
                      )}
                    </Show>
                    <Show when={state().draft[key]}>
                      {(url) => (
                        <>
                          <PostMedia
                            profileImage={{ url: url(), label: entry().label }}
                            session={props.session}
                            isActive={() => state().visible && props.isActive()}
                          />
                          <button
                            type="button"
                            class="text-button"
                            onClick={() => props.controller.setField(key, "")}
                          >
                            {entry().label}を削除
                          </button>
                        </>
                      )}
                    </Show>
                    <details>
                      <summary>{entry().label}のURLを指定</summary>
                      <label>
                        {entry().label}のURL
                        <input
                          type="text"
                          inputMode="url"
                          maxLength={2000}
                          value={state().draft[key]}
                          onInput={(e) =>
                            props.controller.setField(
                              key,
                              e.currentTarget.value,
                            )
                          }
                        />
                      </label>
                    </details>
                  </fieldset>
                );
              }}
            </Index>
            <fieldset>
              <legend>追加項目（4件まで）</legend>
              <div ref={rows}>
                <Index each={state().draft.fields}>
                  {(field, index) => (
                    <div>
                      <label>
                        項目{index + 1}の名前
                        <input
                          value={field().name}
                          maxLength={255}
                          onInput={(e) =>
                            props.controller.setField(
                              "fields",
                              state().draft.fields.map((row, n) =>
                                n === index
                                  ? { ...row, name: e.currentTarget.value }
                                  : row,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        項目{index + 1}の内容
                        <input
                          value={field().value}
                          maxLength={255}
                          onInput={(e) =>
                            props.controller.setField(
                              "fields",
                              state().draft.fields.map((row, n) =>
                                n === index
                                  ? { ...row, value: e.currentTarget.value }
                                  : row,
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        type="button"
                        class="text-button"
                        aria-label={`追加項目${index + 1}を削除`}
                        onClick={() => {
                          props.controller.setField(
                            "fields",
                            state().draft.fields.filter((_, n) => n !== index),
                          );
                          focusRow(index);
                        }}
                      >
                        項目を削除
                      </button>
                    </div>
                  )}
                </Index>
              </div>
              <Show when={state().draft.fields.length < 4}>
                <button
                  ref={add}
                  type="button"
                  class="text-button"
                  onClick={() => {
                    props.controller.setField("fields", [
                      ...state().draft.fields,
                      { name: "", value: "" },
                    ]);
                    focusRow(state().draft.fields.length - 1);
                  }}
                >
                  項目を追加
                </button>
              </Show>
            </fieldset>
            <Show when={state().validation}>
              <p role="alert">{state().validation}</p>
            </Show>
            <div class="profile-editor-actions">
              <button
                ref={save}
                type="submit"
                class="primary"
                disabled={!state().canSave}
              >
                {state().saving ? "保存を確認中…" : "保存"}
              </button>
              <button
                type="button"
                class="text-button"
                disabled={state().busy}
                onClick={() => void props.controller.discard()}
              >
                入力を破棄して再読込
              </button>
            </div>
          </form>
        </Show>
        <button
          ref={reload}
          type="button"
          class="text-button"
          disabled={state().busy}
          onClick={() => void run(true)}
        >
          現在の保存状態を確認
        </button>
        <Show when={state().message}>
          <p role="status">{state().message}</p>
        </Show>
        <Show when={state().refreshError}>
          <p role="alert">{state().refreshError}</p>
        </Show>
      </section>
    </Show>
  );
}
