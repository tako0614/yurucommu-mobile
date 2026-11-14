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
import { FeedRecoveryError, type FeedRecoveryPort, type FeedRecoverySnapshot, type FeedRecoveryIntent, type FeedRecoveryAttachment, type FeedInvalidRecoveryReview } from "./feed-recovery.ts";

export type FeedVisibility = MobilePostVisibility;
export const MAX_MOBILE_ATTACHMENTS = 8;

export interface FeedAttachment {
  readonly id: number;
  readonly name: string;
  readonly contentType: string;
  readonly previewUrl: string;
  readonly phase: "queued" | "uploading" | "ready" | "error" | "reselect";
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
  readonly replyContextChanged?: boolean;
  readonly recovery?: { readonly ready: boolean; readonly loading: boolean; readonly saving: boolean; readonly error: string;
    readonly intent?: FeedRecoveryIntent; readonly canConfirmReview: boolean; readonly checkingOutcome: boolean;
    readonly canReviewInvalid: boolean; readonly reviewingInvalid: boolean; readonly discardingInvalid: boolean; readonly invalidReview: boolean; readonly discardPending: boolean };

}

// One authority incarnation owns its draft and pending send. Its request keeps
// the submitted revision, independently of edits made while awaiting the ACK.
export function createFeedController(options: {
  session: MobileSession;
  refreshHome: () => Promise<void>;
  /** Must perform and display a canonical read, and reject if that read fails. */
  readRecoveryOutcome?: () => Promise<void>;
  onChange?: (state: FeedState) => void;
  isActive?: () => boolean;
  replyTo?: MobileReplyTarget & Readonly<{ visibility: FeedVisibility }>;
  recovery?: Pick<FeedRecoveryPort, "save"> & Partial<Pick<FeedRecoveryPort, "load" | "reviewInvalid">>;
}) {
  let replyTarget = options.replyTo ? { ...options.replyTo } : undefined;
  let previousReplyTarget: typeof replyTarget;
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
  let recoveryLoaded = !options.recovery?.load, recoveryRetired = false, recoveryError = "", recoverySaving = 0;
  let recoveryRevision = 0, savedRecoveryRevision = 0;
  let recoveryLoad: Promise<void> | undefined, recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let sendIntent: FeedRecoveryIntent | undefined, confirmingIntent: string | undefined;
  let recoveryReviewed = false, checkingOutcome = false;
  let recoveryInvalid = false, reviewingInvalid = false, discardingInvalid = false, invalidDiscardPending = false, invalidReviewEpoch = 0;
  let invalidResolution: Promise<boolean> | undefined;
  let invalidReview: { value: FeedInvalidRecoveryReview; port: NonNullable<typeof options.recovery>; authority: number; revision: number } | undefined;

  let nextAttachmentId = 0;
  type Entry = {
    view: FeedAttachment;
    file?: File;
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
      recovery: options.recovery ? { ready: recoveryLoaded, loading: !recoveryLoaded && !!recoveryLoad, saving: recoverySaving > 0,
        error: recoveryError, intent: sendIntent, canConfirmReview: !!sendIntent && recoveryReviewed && !recoveryInvalid && !invalidDiscardPending && !invalidReview && !reviewingInvalid && !discardingInvalid && !sending && recoverySaving === 0 && !checkingOutcome,
        checkingOutcome, canReviewInvalid: active(authority) && !recoveryRetired && recoveryInvalid && !!options.recovery.reviewInvalid && !!options.recovery.load && !!options.readRecoveryOutcome && !sending && recoverySaving === 0 && !recoveryLoad && !checkingOutcome && !confirmingIntent && !reviewingInvalid && !discardingInvalid && !invalidReview && !pendingUploads(),
        reviewingInvalid, discardingInvalid, invalidReview: !!invalidReview, discardPending: invalidDiscardPending } : undefined,
      ...(replyTarget ? { replyAudienceNeedsChoice: !audienceConfirmed, replyContextChanged: !!previousReplyTarget } : {}),
      canSubmit:
        !previousReplyTarget &&
        (!options.recovery || (recoveryLoaded && !recoveryRetired && !recoveryError && !sendIntent && !confirmingIntent && !invalidDiscardPending && !invalidReview && !reviewingInvalid && !discardingInvalid)) &&
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
  function pendingUploads() { return Array.from(attachments.values()).some(entry => entry.view.phase === "queued" || entry.view.phase === "uploading"); }

  function recoverySnapshot(): FeedRecoverySnapshot {
    const saved: FeedRecoveryAttachment[] = Array.from(attachments.values(), entry => entry.uploaded
      ? { phase: "ready", upload: { ...entry.uploaded } }
      : { phase: "reselect", name: entry.view.name, contentType: entry.view.contentType,
        ...(entry.file ? { size: entry.file.size } : {}) });
    return { content, visibility, attachments: saved,
      ...(replyTarget ? { reply: { target: { ...(previousReplyTarget ?? replyTarget) }, audienceConfirmed } } : {}),
      ...(sendIntent && sendIntent.id !== confirmingIntent ? { intent: { ...sendIntent, media: sendIntent.media.map(item => ({ ...item })) } } : {}) };
  }
  function adoptRecovery(saved: FeedRecoverySnapshot | null) {
    if (saved) {
      if (replyTarget ? !saved.reply || saved.reply.target.apId !== replyTarget.apId : !!saved.reply) {
        throw new Error("保存した下書きと現在の返信先設定が一致しません。");
      }
      if (saved.reply && replyTarget && (saved.reply.target.visibility !== replyTarget.visibility ||
        saved.reply.target.communityApId !== replyTarget.communityApId)) previousReplyTarget = { ...saved.reply.target };
      if (draftRevision === 0) { content = saved.content; visibility = saved.visibility; }
      if (saved.reply) audienceConfirmed = saved.reply.audienceConfirmed;
      for (const item of saved.attachments) {
        const uploaded = item.phase === "ready" ? { ...item.upload } : undefined;
        const view: FeedAttachment = { id: ++nextAttachmentId, name: uploaded?.name ?? (item.phase === "reselect" ? item.name : "添付"),
          contentType: uploaded?.content_type ?? (item.phase === "reselect" ? item.contentType : ""), previewUrl: "",
          phase: uploaded ? "ready" : "reselect", ...(uploaded ? {} : { error: "元のファイルを再選択してください。" }) };
        attachments.set(view.id, { uploaded, view });
      }
      sendIntent = saved.intent ? { ...saved.intent, phase: "uncertain" } : undefined;
      if (sendIntent) error = replyTarget ? "再起動前の返信結果は未確認です。再送する前に元の内容と返信一覧を確認してください。"
        : "再起動前の投稿結果は未確認です。元の内容とフィードを確認してください。";
    }
  }
  function restoreRecovery(): Promise<void> {
    if (invalidDiscardPending) return finishInvalidDiscard().then(() => {});
    if (recoveryLoaded || !options.recovery?.load || recoveryRetired || !active(authority)) return Promise.resolve();
    if (recoveryLoad) return recoveryLoad;
    const expected = authority;
    recoveryError = "";
    recoveryLoad = (async () => {
      try {
        const saved = await options.recovery!.load!();
        if (!active(expected) || recoveryRetired) return;
        adoptRecovery(saved);
        recoveryLoaded = true; recoveryInvalid = false;
      } catch (cause) {
        if (active(expected)) {
          recoveryInvalid = cause instanceof FeedRecoveryError && cause.code === "invalid-data";
          recoveryError = "保存した投稿下書きを確認できませんでした。再確認するまで保存・送信を待機します。";
        }
      }
      finally { if (active(expected)) { recoveryLoad = undefined; publish(); } }
    })();
    publish(); return recoveryLoad;
  }
  async function checkpointRecovery(expected: number) {
    if (!options.recovery) return;
    if (!recoveryLoaded) throw new Error("投稿下書きの確認が必要です。");
    let revision: number;
    do {
      if (!active(expected) || recoveryRetired) return;
      revision = recoveryRevision;
      await options.recovery.save(recoverySnapshot());
      if (active(expected)) savedRecoveryRevision = revision;
    } while (active(expected) && !recoveryRetired && recoveryRevision !== revision);
  }
  async function persistRecovery(): Promise<boolean> {
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    if (!options.recovery || recoveryRetired || !active(authority) || reviewingInvalid || discardingInvalid) return false;
    if (invalidDiscardPending && !await finishInvalidDiscard()) return false;
    if (!recoveryLoaded) await restoreRecovery();
    if (!recoveryLoaded || recoveryRetired || !active(authority)) return false;
    const expected = authority; recoverySaving++; publish();
    try { await checkpointRecovery(expected); if (active(expected)) { recoveryError = ""; recoveryInvalid = false; } return active(expected); }
    catch (cause) {
      if (active(expected)) {
        recoveryInvalid ||= cause instanceof FeedRecoveryError && cause.code === "invalid-data";
        recoveryError = "投稿下書きの保存を確認できませんでした。保存を再試行してください。";
      }
      return false;
    }
    finally { recoverySaving--; publish(); }
  }
  async function flushRecovery() { await persistRecovery(); }
  function changedRecovery() {
    recoveryRevision++;
    invalidReview = undefined;
    if (!options.recovery || !recoveryLoaded || recoveryRetired || recoveryError || !active(authority)) return;
    clearTimeout(recoveryTimer); recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void flushRecovery(); }, 150);
  }
  async function reviewRecoveryOutcome() {
    if (invalidDiscardPending) { await finishInvalidDiscard(); return; }
    if (!sendIntent || !options.readRecoveryOutcome || checkingOutcome || sending || !active(authority) || recoveryRetired || reviewingInvalid || discardingInvalid || invalidReview) return;
    const expected = authority, id = sendIntent.id; checkingOutcome = true; recoveryReviewed = false; publish();
    try { await options.readRecoveryOutcome(); if (active(expected) && sendIntent?.id === id) recoveryReviewed = true; }
    catch { if (active(expected)) recoveryError = replyTarget ? "返信一覧を確認できませんでした。下書きと元の返信内容は保持しています。"
      : "フィードを確認できませんでした。下書きと元の投稿内容は保持しています。"; }
    finally { checkingOutcome = false; publish(); }
  }
  async function confirmRecoveryReview() {
    if (!getState().recovery?.canConfirmReview || !sendIntent || !active(authority) || recoveryRetired) return;
    const expected = authority, original = sendIntent; confirmingIntent = original.id;
    try {
      if (await persistRecovery() && active(expected) && sendIntent === original) {
        sendIntent = undefined; error = ""; recoveryReviewed = false;
      }
    } finally { confirmingIntent = undefined; publish(); }
  }
  async function confirmReplyContext() {
    if (!previousReplyTarget || !replyTarget || !recoveryLoaded || recoveryRetired || !active(authority) || sending || recoverySaving) return;
    // The canonical parent remains authoritative. Adoption changes only the
    // next draft; the original uncertain intent keeps its original context.
    previousReplyTarget = undefined;
    visibility = replyTarget.visibility;
    audienceConfirmed = replyTarget.visibility !== "followers";
    draftRevision++; changedRecovery();
    await persistRecovery(); publish();
  }

  async function reviewInvalidRecovery() {
    if (!getState().recovery?.canReviewInvalid || !options.recovery?.reviewInvalid) return;
    const port = options.recovery, expected = authority, revision = recoveryRevision, epoch = ++invalidReviewEpoch;
    reviewingInvalid = true; publish();
    try {
      if (!active(expected) || recoveryRetired || options.recovery !== port) return;
      const value = await port.reviewInvalid!();
      if (active(expected) && !recoveryRetired && options.recovery === port && recoveryRevision === revision && invalidReviewEpoch === epoch)
        invalidReview = { value, port, authority: expected, revision };
    } catch {
      if (active(expected)) recoveryError = "下書きの保存範囲・破損内容を確認できませんでした。破棄せず再確認してください。";
    } finally { reviewingInvalid = false; publish(); }
  }
  async function discardInvalidRecovery() {
    const review = invalidReview;
    if (!review || !active(review.authority) || recoveryRetired || options.recovery !== review.port || sending || recoverySaving || checkingOutcome || confirmingIntent || reviewingInvalid || discardingInvalid || pendingUploads()) return;
    invalidReview = undefined;
    if (review.revision !== recoveryRevision) { publish(); return; }
    invalidDiscardPending = true; recoveryReviewed = false; discardingInvalid = true; publish();
    try {
      if (!active(review.authority) || recoveryRetired || options.recovery !== review.port) return;
      await review.value.discard();
      if (!active(review.authority) || recoveryRetired || options.recovery !== review.port) return;
      discardingInvalid = false;
      await finishInvalidDiscard();
    } catch {
      if (active(review.authority)) recoveryError = "下書き保存の破棄を確認できませんでした。入力を保持し、保存・送信の待機を続けます。再確認してください。";
    } finally { discardingInvalid = false; publish(); }
  }
  function finishInvalidDiscard(): Promise<boolean> {
    if (invalidResolution) return invalidResolution;
    const port = options.recovery, expected = authority;
    if (!invalidDiscardPending || !port?.load || !options.readRecoveryOutcome || !active(expected) || recoveryRetired || sending || recoverySaving || reviewingInvalid || discardingInvalid || checkingOutcome) return Promise.resolve(false);
    checkingOutcome = true; recoveryReviewed = false; publish();
    invalidResolution = Promise.resolve().then(async () => {
      try {
        if (!active(expected) || recoveryRetired || options.recovery !== port) return false;
        const saved = await port.load!();
        if (!active(expected) || recoveryRetired || options.recovery !== port) return false;
        // Preserve both live input and a different valid stored record.
        if (recoveryLoaded && saved !== null) throw new FeedRecoveryError("changed");
        recoveryInvalid = false;
        await options.readRecoveryOutcome!();
        if (!active(expected) || recoveryRetired || options.recovery !== port) return false;
        if (!recoveryLoaded) adoptRecovery(saved);
        recoveryLoaded = true;
        invalidDiscardPending = false; recoveryError = "";
        recoveryReviewed = !!sendIntent;
        if (content || attachments.size || sendIntent) changedRecovery();
        return true;
      } catch (cause) {
        if (active(expected)) recoveryError = cause instanceof FeedRecoveryError && cause.code === "changed"
          ? "別の下書きが保存されています。この画面の入力を保持して上書きを止めました。保存側を使う場合は入力を控えてからアプリを開き直してください。"
          : "破棄後の保存先または現在の投稿結果を確認できませんでした。入力を保持し、送信を待機します。再確認してください。";
        return false;
      } finally { checkingOutcome = false; invalidResolution = undefined; publish(); }
    });
    return invalidResolution;
  }
  function cancelInvalidRecoveryReview() {
    if (discardingInvalid) return;
    invalidReview = undefined; invalidReviewEpoch++; publish();
  }

  function setDraft(value: string) {
    if (!active(authority) || !recoveryLoaded || value === content) return;
    content = value;
    draftRevision += 1;
    changedRecovery();
    publish();
  }

  function setVisibility(value: FeedVisibility) {
    if (!active(authority) || !recoveryLoaded || previousReplyTarget) return;
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
    changedRecovery();
    publish();
  }

  function clearDraft() {
    if (!active(authority)) return;
    content = "";
    clearAttachments();
    attachmentError = "";
    draftRevision += 1;
    changedRecovery();
    publish();
  }

  function releaseEntry(entry: Entry) {
    entry.abort?.abort();
    if (entry.view.previewUrl) URL.revokeObjectURL(entry.view.previewUrl);
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
    changedRecovery();
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
          changedRecovery(); publish();
          try {
            const uploaded = await uploadPostMedia(
              selected,
              entry.file!,
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
            if (active(expected)) { changedRecovery(); publish(); }
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
    if (!active(authority) || !recoveryLoaded || !files.length || reviewingInvalid || discardingInvalid || invalidDiscardPending) return Promise.resolve();
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
    changedRecovery();
    publish();
    return runUploads();
  }

  function retryAttachment(id: number): Promise<void> {
    if (!active(authority) || reviewingInvalid || discardingInvalid || invalidDiscardPending) return Promise.resolve();
    const entry = attachments.get(id);
    if (!entry || entry.view.phase !== "error" || !entry.file) return Promise.resolve();
    entry.view = { ...entry.view, phase: "queued", error: undefined };
    draftRevision += 1;
    changedRecovery();
    publish();
    return runUploads();
  }

  async function submit() {
    if (!active(authority) || !getState().canSubmit) return;
    let expiredMedia = false;
    for (const entry of attachments.values()) {
      if (
        entry.uploaded?.expiresAt &&
        Date.parse(entry.uploaded.expiresAt) <= Date.now()
      ) {
        expiredMedia = true;
        entry.uploaded = undefined;
        entry.view = {
          ...entry.view,
          phase: entry.file ? "error" : "reselect",
          error: "添付の有効期限が切れました。元のファイルを再選択してください。",
        };
      }
    }
    if (expiredMedia) changedRecovery();
    if (!getState().canSubmit) {
      publish();
      return;
    }
    const expected = authority;
    const attempt = ++sendRevision;
    const revision = draftRevision;
    const submittedContent = content;
    const submittedVisibility = visibility;
    const submittedReplyTarget = replyTarget ? { ...replyTarget } : undefined;
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
    let accepted = false, dispatched = false;
    // This ID correlates local work within the incarnation; it is never a server idempotency key.
    const originalIntent: FeedRecoveryIntent = { id: "local-" + attempt, phase: "pending", content: submittedContent,
      visibility: submittedVisibility, media: submittedMedia.map(item => ({ ...item })),
      ...(submittedReplyTarget ? { replyTo: submittedReplyTarget } : {}) };
    if (options.recovery) { sendIntent = originalIntent; recoveryRevision++; }
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    try {
      if (options.recovery) {
        await checkpointRecovery(expected);
        if (!active(expected) || recoveryRetired || requestAbort.signal.aborted) return;
        if (submittedMedia.some(item => item.expiresAt !== undefined && Date.parse(item.expiresAt) <= Date.now())) {
          for (const entry of submittedEntries) {
            if (attachments.get(entry.view.id) === entry && entry.uploaded?.expiresAt !== undefined && Date.parse(entry.uploaded.expiresAt) <= Date.now()) {
              entry.uploaded = undefined; entry.view = { ...entry.view, phase: entry.file ? "error" : "reselect", error: "元のファイルを再選択してください。" };
            }
          }
          changedRecovery();
          throw new Error("添付の有効期限が切れました。再アップロードしてください。");
        }
      }
      dispatched = true;
      await createPost(
        submittedSession,
        submittedContent,
        submittedVisibility,
        submittedMedia,
        requestAbort.signal,
        submittedReplyTarget,
      );
      if (!active(expected)) return;
      accepted = true; sendIntent = undefined; recoveryRevision++;
      status = replyTarget ? "返信を投稿しました。" : "投稿を送信しました。";
      if (draftRevision === revision) {
        content = "";
        draftRevision += 1;
        changedRecovery();
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
      if (options.recovery) {
        sendIntent = dispatched ? { ...originalIntent, phase: "uncertain" } : undefined;
        recoveryRevision++;
        if (!dispatched) recoveryError = "投稿前の保存または添付の確認が必要です。保存を再試行してください。";
      }
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
        if (dispatched && options.recovery) await persistRecovery();
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
    invalidReview = undefined; recoveryReviewed = false;
    const wasSending = sending;
    authority += 1;
    if (!recoveryLoaded) recoveryLoad = undefined;
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
    // Before restore completes, pausing a read is not a user draft edit.
    if (recoveryLoaded) draftRevision += 1;
    changedRecovery();
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
    const previous = previousReplyTarget ?? replyTarget;
    pause();
    replyTarget = { ...target };
    if (options.recovery && recoveryLoaded) previousReplyTarget = { ...previous };
    else {
      visibility = target.visibility;
      audienceConfirmed = target.visibility !== "followers";
    }
    if (recoveryLoaded) draftRevision += 1;
    changedRecovery();
    publish();
  }

  function updateSession(next: MobileSession) {
    if (disposed) return;
    const key = feedSessionIdentity(next);
    session = snapshotFeedSession(next);
    if (key === sessionKey) return;
    sessionKey = key;
    invalidReview = undefined; invalidReviewEpoch++; invalidDiscardPending = false;
    clearTimeout(recoveryTimer); recoveryTimer = undefined; recoveryRetired = !!options.recovery;
    sendIntent = undefined; recoveryReviewed = false; recoveryError = "";
    authority += 1;
    postAbort?.abort();
    postAbort = undefined;
    clearAttachments();
    pump = undefined;
    sendRevision += 1;
    draftRevision += 1;
    changedRecovery();
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
    if (options.recovery && recoveryLoaded && !recoveryRetired && !recoveryError && savedRecoveryRevision !== recoveryRevision) void flushRecovery();
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    disposed = true;
    invalidReview = undefined; invalidReviewEpoch++;
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
    restoreRecovery, flushRecovery, reviewRecoveryOutcome, confirmRecoveryReview, confirmReplyContext,
    reviewInvalidRecovery, discardInvalidRecovery, cancelInvalidRecoveryReview,
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
