import type { MobileSession } from "@takosjp/mobile-kit";
import { apiFetch } from "@takosjp/yurucommu-api";
import { withMobileApiTransport, readMobileResponseJson } from "./api.ts";
import { snapshotFeedSession } from "./feed-session.ts";
import {
  decodeMobileProfile,
  validMobileActorApId,
  type MobileProfile,
} from "./profile-api.ts";
export interface MobileProfileForm {
  name: string;
  summary: string;
  icon_url: string;
  header_url: string;
  is_private: boolean;
  fields: { name: string; value: string }[];
}
export type MobileProfilePatch = Partial<MobileProfileForm>;
export const profileFormKeys = [
  "name",
  "summary",
  "icon_url",
  "header_url",
  "is_private",
  "fields",
] as const;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const profileForm = (actor: MobileProfile): MobileProfileForm => ({
  name: actor.name ?? "",
  summary: actor.summary ?? "",
  icon_url: actor.icon_url ?? "",
  header_url: actor.header_url ?? "",
  is_private: actor.is_private === true,
  fields: actor.fields.map((row) => ({ ...row })),
});
function imageUrl(value: string) {
  if (!value) return true;
  if (/[\\\s]/u.test(value)) return false;
  try {
    const u = new URL(value, "https://profile-url.example");
    return (
      !u.username &&
      !u.password &&
      (value.startsWith("/media/")
        ? u.origin === "https://profile-url.example" &&
          u.pathname.startsWith("/media/") &&
          !u.search &&
          !u.hash
        : /^https?:\/\//u.test(value) &&
          ["http:", "https:"].includes(u.protocol))
    );
  } catch {
    return false;
  }
}
export function normalizeProfilePatch(
  input: MobileProfilePatch,
): MobileProfilePatch {
  if (
    !record(input) ||
    Object.keys(input).some(
      (k) => !profileFormKeys.includes(k as (typeof profileFormKeys)[number]),
    )
  )
    throw Error("プロフィールの入力が不正です。");
  const patch: MobileProfilePatch = {};
  for (const key of ["name", "summary", "icon_url", "header_url"] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string")
      throw Error("プロフィールの文字列が不正です。");
    const value = raw.trim(),
      max = key === "name" ? 50 : key === "summary" ? 500 : 2000;
    if (value.length > max) throw Error(`入力は${max}文字以内にしてください。`);
    if ((key === "icon_url" || key === "header_url") && !imageUrl(value))
      throw Error("画像はHTTP(S) URLか正規アップロード先を指定してください。");
    patch[key] = value;
  }
  if (input.is_private !== undefined) {
    if (typeof input.is_private !== "boolean")
      throw Error("承認制フォローの設定が不正です。");
    patch.is_private = input.is_private;
  }
  if (input.fields !== undefined) {
    if (!Array.isArray(input.fields) || input.fields.length > 4)
      throw Error("追加項目は4件までです。");
    patch.fields = input.fields
      .map((row) => {
        if (
          !record(row) ||
          typeof row.name !== "string" ||
          typeof row.value !== "string"
        )
          throw Error("追加項目が不正です。");
        const name = row.name.trim(),
          value = row.value.trim();
        if (name.length > 255 || value.length > 255)
          throw Error("追加項目は各255文字以内にしてください。");
        return { name, value };
      })
      .filter((row) => row.name || row.value);
  }
  return patch;
}
export function changedProfileFields(
  draft: MobileProfileForm,
  base: MobileProfileForm,
): MobileProfilePatch {
  const normalized = normalizeProfilePatch(draft),
    patch: MobileProfilePatch = {};
  for (const key of profileFormKeys)
    if (!equal(normalized[key], base[key]))
      Object.assign(patch, { [key]: normalized[key] });
  return patch;
}
type Request = (
  path: string,
  method?: string,
  body?: string,
) => Promise<Response>;
async function scope<T>(
  session: MobileSession,
  signal: AbortSignal | undefined,
  work: (request: Request) => Promise<T>,
) {
  const selected = snapshotFeedSession(session),
    owned = new AbortController(),
    cancel = () => owned.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(
    () =>
      owned.abort(
        Error("プロフィールの保存状態を時間内に確認できませんでした。"),
      ),
    15000,
  );
  const request: Request = (path, method = "GET", body) => {
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
    const value = await work(request);
    if (owned.signal.aborted) throw owned.signal.reason;
    return value;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
    owned.abort();
  }
}
async function json(response: Response, maximum: number) {
  if (!response.ok) {
    let detail = "";
    try {
      const body = await readMobileResponseJson(
        response,
        16 * 1024,
        "プロフィール",
      );
      if (record(body) && typeof body.error === "string")
        detail = body.error.slice(0, 500);
    } catch {}
    throw Error(
      `プロフィールを確認できませんでした（${response.status}）。 ${detail}`,
    );
  }
  return readMobileResponseJson(response, maximum, "プロフィール");
}
async function verifyViewer(request: Request, id: string) {
  const raw = await json(await request("/api/auth/me"), 128 * 1024);
  if (!record(raw) || !record(raw.actor) || raw.actor.ap_id !== id)
    throw Error("編集する本人の識別子が一致しません。");
}
async function canonical(request: Request, id: string): Promise<MobileProfile> {
  const raw = await json(
    await request("/api/actors/" + encodeURIComponent(id)),
    256 * 1024,
  );
  if (!record(raw) || !record(raw.actor) || raw.actor.ap_id !== id)
    throw Error("保存先のプロフィールが一致しません。");
  const actor = raw.actor;
  if (
    !profileFormKeys.every((k) => k in actor) ||
    !(
      typeof actor.is_private === "boolean" ||
      actor.is_private === 0 ||
      actor.is_private === 1
    ) ||
    !Array.isArray(actor.fields)
  )
    throw Error("編集に必要なプロフィール項目が不足しています。");
  return decodeMobileProfile(actor);
}
export async function loadMobileEditableProfile(
  session: MobileSession,
  id: string,
  signal?: AbortSignal,
) {
  if (!validMobileActorApId(id))
    throw Error("編集する本人の識別子が不正です。");
  return scope(session, signal, async (request) => {
    await verifyViewer(request, id);
    return canonical(request, id);
  });
}
export async function saveMobileProfile(
  session: MobileSession,
  id: string,
  input: MobileProfilePatch,
  signal?: AbortSignal,
) {
  if (!validMobileActorApId(id))
    throw Error("編集する本人の識別子が不正です。");
  const patch = normalizeProfilePatch(input);
  if (!Object.keys(patch).length) throw Error("保存する変更がありません。");
  return scope(session, signal, async (request) => {
    await verifyViewer(request, id);
    const ack = await json(
      await request("/api/actors/me", "PUT", JSON.stringify(patch)),
      16 * 1024,
    );
    if (!record(ack) || ack.success !== true)
      throw Error("プロフィールの保存応答を確認できませんでした。");
    const actor = await canonical(request, id),
      persisted = profileForm(actor);
    if (
      !Object.keys(patch).every((key) =>
        equal(
          patch[key as keyof MobileProfileForm],
          persisted[key as keyof MobileProfileForm],
        ),
      )
    )
      throw Error(
        "保存したプロフィールが入力と一致しません。状態を確認してください。",
      );
    await verifyViewer(request, id);
    return actor;
  });
}
