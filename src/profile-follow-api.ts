import type { MobileSession } from "@takosjp/mobile-kit";
import { apiFetch } from "@takosjp/yurucommu-api";
import { snapshotFeedSession } from "./feed-session.ts";
import {
  withMobileReadScope,
  withMobileApiTransport,
  readMobileResponseJson,
} from "./api.ts";
import {
  decodeMobileProfile,
  validMobileActorApId,
  type MobileProfile,
} from "./profile-api.ts";
export type MobileFollowStatus = "none" | "pending" | "accepted";
export interface MobileFollowReceipt {
  readonly actor: MobileProfile;
  readonly viewerId: string;
  readonly viewerFollowing: number | null;
  readonly status: MobileFollowStatus | null;
  readonly isSelf: boolean;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
async function json(response: Response, maximum: number, operation: string) {
  if (!response.ok) {
    let message = `${operation}できませんでした（${response.status}）。`;
    try {
      const value = await readMobileResponseJson(
        response,
        16 * 1024,
        operation,
      );
      if (record(value) && typeof value.error === "string")
        message += " " + value.error.slice(0, 500);
    } catch {}
    throw Error(message);
  }
  return readMobileResponseJson(response, maximum, operation);
}
async function viewer(request: (path: string) => Promise<Response>) {
  const value = await json(
    await request("/api/auth/me"),
    128 * 1024,
    "本人確認",
  );
  if (
    !record(value) ||
    !record(value.actor) ||
    typeof value.actor.ap_id !== "string" ||
    !validMobileActorApId(value.actor.ap_id)
  )
    throw Error("本人の識別子を確認できませんでした。");
  const count = value.actor.following_count;
  if (
    count !== undefined &&
    count !== null &&
    (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
  )
    throw Error("本人の件数を確認できませんでした。");
  return {
    id: value.actor.ap_id,
    following: typeof count === "number" ? count : null,
  };
}
async function target(
  request: (path: string) => Promise<Response>,
  id: string,
) {
  const value = await json(
    await request(`/api/actors/${encodeURIComponent(id)}`),
    256 * 1024,
    "フォロー状態の確認",
  );
  if (!record(value) || !record(value.actor))
    throw Error("フォロー状態の応答が不正です。");
  const actor = decodeMobileProfile(value.actor);
  if (actor.ap_id !== id) throw Error("フォロー先の本人識別子が一致しません。");
  const raw = value.actor.outgoing_follow_status,
    flag = value.actor.is_following;
  let status: MobileFollowStatus | null = null;
  if (raw !== undefined && raw !== null) {
    if (
      typeof raw !== "string" ||
      !["none", "pending", "accepted"].includes(raw) ||
      typeof flag !== "boolean" ||
      flag !== (raw === "accepted")
    )
      throw Error("フォロー状態の整合性を確認できませんでした。");
    status = raw as MobileFollowStatus;
  }
  return { actor, status };
}
export async function loadMobileProfileFollow(
  session: MobileSession,
  id: string,
  signal?: AbortSignal,
): Promise<MobileFollowReceipt> {
  if (!validMobileActorApId(id)) throw Error("フォロー先の識別子が不正です。");
  return withMobileReadScope(session, signal, async (request) => {
    const me = await viewer(request),
      value = await target(request, id);
    return {
      ...value,
      viewerId: me.id,
      viewerFollowing: me.following,
      isSelf: me.id === id,
    };
  });
}
export async function setMobileProfileFollow(
  session: MobileSession,
  id: string,
  following: boolean,
  signal?: AbortSignal,
): Promise<MobileFollowReceipt> {
  if (!validMobileActorApId(id)) throw Error("フォロー先の識別子が不正です。");
  const selected = snapshotFeedSession(session),
    owned = new AbortController();
  const cancel = () => owned.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(
    () => owned.abort(Error("フォローの結果を時間内に確認できませんでした。")),
    15000,
  );
  const request = (path: string, method = "GET", body?: string) => {
    if (owned.signal.aborted) return Promise.reject(owned.signal.reason);
    return withMobileApiTransport(selected, () =>
      apiFetch(path, {
        method,
        body,
        ...(body ? { headers: { "content-type": "application/json" } } : {}),
        signal: owned.signal,
        timeoutMs: 0,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
  };
  try {
    const me = await viewer(request);
    if (me.id === id) throw Error("自分自身へのフォロー操作はできません。");
    const ack = await json(
      await request(
        "/api/follow",
        following ? "POST" : "DELETE",
        JSON.stringify({ target_ap_id: id }),
      ),
      16 * 1024,
      "フォローの変更",
    );
    if (
      !record(ack) ||
      ack.success !== true ||
      (following && ack.status !== "pending" && ack.status !== "accepted")
    )
      throw Error("フォローの変更結果を確認できませんでした。");
    const value = await target(request, id);
    if (
      value.status === null ||
      (following &&
        (value.status === "none" ||
          (ack.status === "accepted" && value.status !== "accepted"))) ||
      (!following && value.status !== "none")
    )
      throw Error("フォローの保存状態が変更結果と一致しません。");
    const after = await viewer(request);
    if (after.id !== me.id) throw Error("操作中に本人の識別子が変わりました。");
    if (owned.signal.aborted) throw owned.signal.reason;
    return {
      ...value,
      viewerId: me.id,
      viewerFollowing: after.following,
      isSelf: false,
    };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    owned.abort();
  }
}
