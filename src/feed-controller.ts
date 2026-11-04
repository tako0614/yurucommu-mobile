import { canSubmitMobileText, type MobileSession } from "@takosjp/mobile-kit";
import {
  createPost,
  uploadPostMedia,
  validateMobileUpload,
  type MobileUploadedAttachment,
  type MobilePostVisibility,
  type MobileReplyTarget,
} from "./api.ts";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";

export type FeedVisibility = MobilePostVisibility;
export const MAX_MOBILE_ATTACHMENTS = 8;

export interface FeedAttachment {
  readonly id: number;
  readonly name: string;
  readonly contentType: string;
  readonly previewUrl: string;
  readonly phase: "queued" | "uploading" | "ready" | "error";
  readonly error?: string;
}

export interface FeedState {
  readonly content: string;
  readonly visibility: FeedVisibility;
  readonly sending: boolean;
  readonly error: string;
  readonly status: string;
  readonly refreshError: string;
  readonly attachments: readonly FeedAttachment[];
  readonly attachmentError: string;
  readonly canSubmit: boolean;
  readonly replyAudienceNeedsChoice?: boolean;
}

// One authority incarnation owns its draft and pending send. Its request keeps
// the submitted revision, independently of edits made while awaiting the ACK.
export function createFeedController(options: {
  session: MobileSession;
  refreshHome: () => Promise<void>;
  onChange?: (state: FeedState) => void;
  isActive?: () => boolean;
  replyTo?: MobileReplyTarget & Readonly<{ visibility: FeedVisibility }>;
}) {
  let replyTarget = options.replyTo ? { ...options.replyTo } : undefined;
  let session = snapshotFeedSession(options.session);
  let sessionKey = feedSessionIdentity(session);
  let authority = 0;
  let draftRevision = 0;
  let sendRevision = 0;
  let disposed = false;
  let content = "";
  let visibility: FeedVisibility = replyTarget?.visibility ?? "public";
  let audienceConfirmed =
    !replyTarget || replyTarget.visibility !== "followers";
  let sending = false;
  let error = "";
  let status = "";
  let refreshError = "";
  let postAbort: AbortController | undefined;
  let attachmentError = "";
  let nextAttachmentId = 0;
  type Entry = {
    view: FeedAttachment;
    file: File;
    uploaded?: MobileUploadedAttachment;
    abort?: AbortController;
  };
  const attachments = new Map<number, Entry>();
  let pump: { authority: number; promise: Promise<void> } | undefined;

  function getState(): FeedState {
    return {
      content,
      visibility,
      sending,
      error,
      status,
      refreshError,
      attachments: Array.from(attachments.values(), (entry) => entry.view),
      attachmentError,
      ...(replyTarget ? { replyAudienceNeedsChoice: !audienceConfirmed } : {}),
      canSubmit:
        audienceConfirmed &&
        canSubmitMobileText({
          value: content,
          disabled: sending,
          maxLength: 500,
        }) &&
        (!replyTarget ||
          visibility !== "direct" ||
          /@[a-zA-Z0-9_]+(?:@[a-zA-Z0-9.-]+)?/.test(content)) &&
        Array.from(attachments.values()).every(
          (entry) => entry.view.phase === "ready",
        ),
    };
  }

  function active(expected: number): boolean {
    return (
      !disposed && authority === expected && options.isActive?.() !== false
    );
  }

  function publish() {
    if (active(authority)) options.onChange?.(getState());
  }

  function setDraft(value: string) {
    if (!active(authority) || value === content) return;
    content = value;
    draftRevision += 1;
    publish();
  }

  function setVisibility(value: FeedVisibility) {
    if (!active(authority)) return;
    if (
      replyTarget &&
      (replyTarget.visibility !== "followers" ||
        (value !== "followers" && value !== "direct"))
    )
      return;
    if (value === visibility && audienceConfirmed) return;
    visibility = value;
    audienceConfirmed = true;
    draftRevision += 1;
    publish();
  }

  function clearDraft() {
    if (!active(authority)) return;
    content = "";
    clearAttachments();
    attachmentError = "";
    draftRevision += 1;
    publish();
  }

  function releaseEntry(entry: Entry) {
    entry.abort?.abort();
    URL.revokeObjectURL(entry.view.previewUrl);
  }

  function clearAttachments() {
    for (const entry of attachments.values()) releaseEntry(entry);
    attachments.clear();
  }

  function removeAttachment(id: number) {
    if (!active(authority)) return;
    const entry = attachments.get(id);
    if (!entry) return;
    attachments.delete(id);
    releaseEntry(entry);
    draftRevision += 1;
    publish();
  }

  function runUploads(): Promise<void> {
    if (pump?.authority === authority) return pump.promise;
    const expected = authority;
    // Defer the loop one microtask so its pump owner exists before any await.
    const promise = Promise.resolve().then(async () => {
      try {
        while (active(expected)) {
          const entry = Array.from(attachments.values()).find(
            (item) => item.view.phase === "queued",
          );
          if (!entry) return;
          const id = entry.view.id;
          const selected = snapshotFeedSession(session);
          const abort = new AbortController();
          entry.abort = abort;
          entry.view = { ...entry.view, phase: "uploading", error: undefined };
          publish();
          try {
            const uploaded = await uploadPostMedia(
              selected,
              entry.file,
              abort.signal,
            );
            if (!active(expected) || attachments.get(id) !== entry) continue;
            entry.uploaded = uploaded;
            entry.view = { ...entry.view, phase: "ready" };
          } catch (cause) {
            if (!active(expected) || attachments.get(id) !== entry) continue;
            entry.uploaded = undefined;
            entry.view = {
              ...entry.view,
              phase: "error",
              error: `${cause instanceof Error ? cause.message : "アップロードの結果を確認できませんでした。"} 自動で再送していません。`,
            };
          } finally {
            if (entry.abort === abort) entry.abort = undefined;
            if (active(expected)) publish();
          }
        }
      } finally {
        if (pump?.authority === expected) pump = undefined;
      }
    });
    pump = { authority: expected, promise };
    return promise;
  }

  function addFiles(files: readonly File[]): Promise<void> {
    if (!active(authority) || !files.length) return Promise.resolve();
    if (attachments.size + files.length > MAX_MOBILE_ATTACHMENTS) {
      attachmentError = `添付は${MAX_MOBILE_ATTACHMENTS}件までです。`;
      publish();
      return Promise.resolve();
    }
    try {
      for (const file of files) validateMobileUpload(file);
    } catch (cause) {
      attachmentError =
        cause instanceof Error ? cause.message : "添付を確認できませんでした。";
      publish();
      return Promise.resolve();
    }
    const selected: Entry[] = [];
    try {
      for (const file of files)
        selected.push({
          file,
          view: {
            id: ++nextAttachmentId,
            name: file.name,
            contentType: file.type,
            previewUrl: URL.createObjectURL(file),
            phase: "queued",
          },
        });
    } catch {
      selected.forEach(releaseEntry);
      attachmentError = "添付のプレビューを作れませんでした。";
      publish();
      return Promise.resolve();
    }
    for (const entry of selected) attachments.set(entry.view.id, entry);
    attachmentError = "";
    draftRevision += 1;
    publish();
    return runUploads();
  }

  function retryAttachment(id: number): Promise<void> {
    if (!active(authority)) return Promise.resolve();
    const entry = attachments.get(id);
    if (!entry || entry.view.phase !== "error") return Promise.resolve();
    entry.view = { ...entry.view, phase: "queued", error: undefined };
    draftRevision += 1;
    publish();
    return runUploads();
  }

  async function submit() {
    if (!active(authority) || !getState().canSubmit) return;
    for (const entry of attachments.values()) {
      if (
        entry.uploaded?.expiresAt &&
        Date.parse(entry.uploaded.expiresAt) <= Date.now()
      ) {
        entry.uploaded = undefined;
        entry.view = {
          ...entry.view,
          phase: "error",
          error: "添付の有効期限が切れました。再アップロードしてください。",
        };
      }
    }
    if (!getState().canSubmit) {
      publish();
      return;
    }
    const expected = authority;
    const attempt = ++sendRevision;
    const revision = draftRevision;
    const submittedContent = content;
    const submittedVisibility = visibility;
    const submittedSession = snapshotFeedSession(session);
    const submittedEntries = Array.from(attachments.values());
    const submittedMedia = submittedEntries.map((entry) => ({
      ...entry.uploaded!,
    }));
    const requestAbort = new AbortController();
    postAbort = requestAbort;
    sending = true;
    error = "";
    status = "";
    refreshError = "";
    publish();
    let accepted = false;
    try {
      await createPost(
        submittedSession,
        submittedContent,
        submittedVisibility,
        submittedMedia,
        requestAbort.signal,
        replyTarget,
      );
      if (!active(expected)) return;
      accepted = true;
      status = replyTarget ? "返信を投稿しました。" : "投稿を送信しました。";
      if (draftRevision === revision) {
        content = "";
        draftRevision += 1;
      }
      // Retire only the files in this accepted post. New files/text selected
      // while it was pending belong to the next draft, even on the same account.
      for (const entry of submittedEntries) {
        if (attachments.get(entry.view.id) === entry) {
          attachments.delete(entry.view.id);
          releaseEntry(entry);
        }
      }
    } catch (cause) {
      if (!active(expected)) return;
      error =
        cause instanceof Error
          ? cause.message
          : "投稿の結果を確認できませんでした。";
      // A network or malformed acknowledgment can follow a committed POST.
      // Keep the draft and never infer that retrying the mutation is safe.
      if (!error.includes("再送する前に")) {
        error += options.replyTo
          ? " 再送する前に返信一覧を確認してください。"
          : " 再送する前にフィードを確認してください。";
      }
    } finally {
      if (postAbort === requestAbort) postAbort = undefined;
      if (active(expected)) {
        sending = false;
        publish();
      }
    }
    if (accepted && active(expected)) {
      try {
        await options.refreshHome();
      } catch {
        if (active(expected) && sendRevision === attempt) {
          refreshError = options.replyTo
            ? "返信は送信済みです。返信一覧を更新できませんでした。"
            : "投稿は送信済みです。フィードを更新できませんでした。";
          publish();
        }
      }
    }
  }

  // A reply can leave the visible route without losing its draft. Retire
  // requests, not content; abort is never a promise of server-side rollback.
  function pause() {
    if (disposed) return;
    const wasSending = sending;
    authority += 1;
    postAbort?.abort();
    postAbort = undefined;
    pump = undefined;
    for (const entry of attachments.values()) {
      if (entry.view.phase !== "uploading" && entry.view.phase !== "queued")
        continue;
      entry.abort?.abort();
      entry.abort = undefined;
      entry.uploaded = undefined;
      entry.view = {
        ...entry.view,
        phase: "error",
        error:
          "アップロードを中断しました。結果を確認してから再アップロードしてください。",
      };
    }
    sending = false;
    if (wasSending)
      error = "送信結果が不明です。返信一覧を確認してから再送してください。";
    status = "";
    refreshError = "";
    sendRevision += 1;
    draftRevision += 1;
    publish();
  }

  function updateReplyContext(
    target: MobileReplyTarget & { visibility: FeedVisibility },
  ) {
    if (
      !replyTarget ||
      target.apId !== replyTarget.apId ||
      disposed ||
      (replyTarget.communityApId === target.communityApId &&
        replyTarget.visibility === target.visibility)
    )
      return;
    pause();
    replyTarget = { ...target };
    visibility = target.visibility;
    audienceConfirmed = target.visibility !== "followers";
    draftRevision += 1;
    publish();
  }

  function updateSession(next: MobileSession) {
    if (disposed) return;
    const key = feedSessionIdentity(next);
    session = snapshotFeedSession(next);
    if (key === sessionKey) return;
    sessionKey = key;
    authority += 1;
    postAbort?.abort();
    postAbort = undefined;
    clearAttachments();
    pump = undefined;
    sendRevision += 1;
    draftRevision += 1;
    content = "";
    visibility = replyTarget?.visibility ?? "public";
    audienceConfirmed = !replyTarget || replyTarget.visibility !== "followers";
    sending = false;
    error = "";
    status = "";
    refreshError = "";
    attachmentError = "";
    publish();
  }

  function dispose() {
    disposed = true;
    postAbort?.abort();
    postAbort = undefined;
    clearAttachments();
    pump = undefined;
    authority += 1;
    sendRevision += 1;
    content = "";
    sending = false;
  }

  return {
    getState,
    setDraft,
    setVisibility,
    clearDraft,
    addFiles,
    removeAttachment,
    retryAttachment,
    submit,
    pause,
    updateReplyContext,
    updateSession,
    dispose,
  };
}
