import type { MobileSession } from "@takosjp/mobile-kit";
import { snapshotFeedSession, feedSessionIdentity } from "./feed-session.ts";
import { mobilePostLikeReadStartedAt as postReadStartedAt, recordMobilePostLikeRead as recordPostRead, } from "./api.ts";
import type { MobileEditablePost } from "./post-edit-api.ts";
// Reuse the existing scoped HTTP-read provenance; changing text must never
// make an old like flag/count look like a new read.
export function createPostEditStore(options: {
    session: MobileSession;
    onChange?: () => void;
}) {
    let session = snapshotFeedSession(options.session);
    const keyOf = (value: MobileSession) => JSON.stringify([feedSessionIdentity(value), value.apiBaseUrl]);
    let key = keyOf(session);
    const receipts = new Map<string, MobileEditablePost>();
    return {
        record(post: MobileEditablePost): boolean {
            const started = postReadStartedAt(post, session), previous = receipts.get(post.ap_id);
            if (started === null || started !== post.readStartedAt || (previous && previous.readStartedAt > started))
                return false;
            receipts.set(post.ap_id, post);
            options.onChange?.();
            return true;
        },
        project<T extends {
            ap_id: string;
            content: string;
            author?: {
                ap_id: string;
            };
        }>(post: T): T {
            const receipt = receipts.get(post.ap_id), started = postReadStartedAt(post, session);
            if (!receipt || (post.author && post.author.ap_id !== receipt.authorId) ||
                (started !== null && started > receipt.readStartedAt))
                return post;
            const fields = post as T & {
                summary?: unknown;
                edited_at?: unknown;
            };
            if (post.content === receipt.content && fields.summary === receipt.summary && fields.edited_at === receipt.edited_at)
                return post;
            const next = { ...post, content: receipt.content, summary: receipt.summary, edited_at: receipt.edited_at };
            return started === null ? next : recordPostRead(next, session, started);
        },
        updateSession(next: MobileSession) {
            const selected = snapshotFeedSession(next), nextKey = keyOf(selected);
            session = selected;
            if (key === nextKey)
                return;
            key = nextKey;
            receipts.clear();
            options.onChange?.();
        },
        clear() { receipts.clear(); options.onChange?.(); },
    };
}
export type PostEditStore = ReturnType<typeof createPostEditStore>;
