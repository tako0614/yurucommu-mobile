import { canSubmitMobileText, type MobileSession } from "@takosjp/mobile-kit";
import { createPost } from "./api.ts";
import { feedSessionIdentity, snapshotFeedSession } from "./feed-session.ts";

export type FeedVisibility = "public" | "unlisted" | "followers";

export interface FeedState {
  readonly content: string;
  readonly visibility: FeedVisibility;
  readonly sending: boolean;
  readonly error: string;
  readonly status: string;
  readonly refreshError: string;
}

// One authority incarnation owns its draft and pending send. Its request keeps
// the submitted revision, independently of edits made while awaiting the ACK.
export function createFeedController(options: {
  session: MobileSession;
  refreshHome: () => Promise<void>;
  onChange?: (state: FeedState) => void;
  isActive?: () => boolean;
}) {
  let session = snapshotFeedSession(options.session);
  let sessionKey = feedSessionIdentity(session);
  let authority = 0;
  let draftRevision = 0;
  let sendRevision = 0;
  let disposed = false;
  let content = "";
  let visibility: FeedVisibility = "public";
  let sending = false;
  let error = "";
  let status = "";
  let refreshError = "";

  function getState(): FeedState {
    return { content, visibility, sending, error, status, refreshError };
  }

  function active(expected: number): boolean {
    return !disposed && authority === expected && options.isActive?.() !== false;
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
    if (!active(authority) || value === visibility) return;
    visibility = value;
    draftRevision += 1;
    publish();
  }

  function clearDraft() {
    if (!active(authority)) return;
    content = "";
    draftRevision += 1;
    publish();
  }

  async function submit() {
    if (!active(authority) || !canSubmitMobileText({
      value: content, disabled: sending, maxLength: 500,
    })) return;
    const expected = authority;
    const attempt = ++sendRevision;
    const revision = draftRevision;
    const submittedContent = content;
    const submittedVisibility = visibility;
    const submittedSession = snapshotFeedSession(session);
    sending = true;
    error = "";
    status = "";
    refreshError = "";
    publish();
    let accepted = false;
    try {
      await createPost(submittedSession, submittedContent, submittedVisibility);
      if (!active(expected)) return;
      accepted = true;
      status = "投稿を送信しました。";
      if (draftRevision === revision) {
        content = "";
        draftRevision += 1;
      }
    } catch (cause) {
      if (!active(expected)) return;
      error = cause instanceof Error ? cause.message : "投稿の結果を確認できませんでした。";
      // A network or malformed acknowledgment can follow a committed POST.
      // Keep the draft and never infer that retrying the mutation is safe.
      if (!error.includes("再送する前に")) {
        error += " 再送する前にフィードを確認してください。";
      }
    } finally {
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
          refreshError = "投稿は送信済みです。フィードを更新できませんでした。";
          publish();
        }
      }
    }
  }

  function updateSession(next: MobileSession) {
    if (disposed) return;
    const key = feedSessionIdentity(next);
    session = snapshotFeedSession(next);
    if (key === sessionKey) return;
    sessionKey = key;
    authority += 1;
    sendRevision += 1;
    draftRevision += 1;
    content = "";
    visibility = "public";
    sending = false;
    error = "";
    status = "";
    refreshError = "";
    publish();
  }

  function dispose() {
    disposed = true;
    authority += 1;
    sendRevision += 1;
    content = "";
    sending = false;
  }

  return { getState, setDraft, setVisibility, clearDraft, submit, updateSession, dispose };
}
