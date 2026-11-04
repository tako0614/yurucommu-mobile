import type { MobileSession } from "@takosjp/mobile-kit";
import { apiFetch } from "@takosjp/yurucommu-api";
import { snapshotFeedSession } from "./feed-session.ts";
import { readMobileResponseJson, withMobileApiTransport } from "./api.ts";
import { validMobileActorApId } from "./profile-api.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export class MobilePostDeleteError extends Error {
  constructor(message: string, readonly outcome: "not_applied" | "unknown", cause?: unknown) {
    super(message, { cause });
    this.name = "MobilePostDeleteError";
  }
}

/** Delete only the selected server's current actor's post, then verify absence. */
export async function deleteMobileOwnPost(
  session: MobileSession,
  postId: string,
  expectedAuthor: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!validMobileActorApId(expectedAuthor)) throw new MobilePostDeleteError("投稿者を確認できませんでした。", "not_applied");
  let parsed: URL;
  try { parsed = new URL(postId); } catch { throw new MobilePostDeleteError("投稿の識別子が不正です。", "not_applied"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new MobilePostDeleteError("投稿の識別子が不正です。", "not_applied");
  const selected = snapshotFeedSession(session), owned = new AbortController();
  const cancel = () => owned.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(() => owned.abort(Error("削除の結果を時間内に確認できませんでした。")), 15_000);
  const request = (path: string, method = "GET") => {
    owned.signal.throwIfAborted();
    return withMobileApiTransport(selected, () => apiFetch(path, {
      method, signal: owned.signal, timeoutMs: 0,
      credentials: "omit", redirect: "error", cache: "no-store",
    }));
  };
  let dispatched = false;
  try {
    const identity = await request("/api/auth/me");
    if (!identity.ok) throw Error(`本人を確認できませんでした（${identity.status}）。`);
    const me = await readMobileResponseJson(identity, 128 * 1024, "本人確認");
    owned.signal.throwIfAborted();
    if (!record(me) || !record(me.actor) || me.actor.ap_id !== expectedAuthor)
      throw Error("自分の投稿であることを確認できませんでした。削除は送信していません。");
    const path = `/api/posts/${encodeURIComponent(postId)}`;
    dispatched = true;
    const response = await request(path, "DELETE");
    if ([401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      throw new MobilePostDeleteError(`投稿を削除できませんでした（${response.status}）。`, "not_applied");
    }
    if (!response.ok) throw Error(`投稿を削除できませんでした（${response.status}）。`);
    const ack = await readMobileResponseJson(response, 16 * 1024, "投稿の削除");
    owned.signal.throwIfAborted();
    if (!record(ack) || ack.success !== true) throw Error("削除の応答を確認できませんでした。");
    const readback = await request(path);
    await readback.body?.cancel();
    owned.signal.throwIfAborted();
    if (readback.status !== 404) throw Error("削除後の投稿の状態を確認できませんでした。");
  } catch (cause) {
    if (cause instanceof MobilePostDeleteError) throw cause;
    throw new MobilePostDeleteError(cause instanceof Error ? cause.message : "削除を確認できませんでした。", dispatched ? "unknown" : "not_applied", cause);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    owned.abort();
  }
}
