import {
  isSafeMobileRoutePath,
  normalizeHostUrl,
  type MobileSession,
} from "@takosjp/mobile-kit";

/**
 * A host route that arrived as a link (`yurucommu://open?path=…`,
 * `yurucommu://open?url=…`) but has no screen in this app.
 */
export interface HostRouteNotice {
  readonly hostUrl: string;
  readonly path: string;
}

/** What the shared shell hands a product for one host route. */
export interface HostRouteHandoffInput {
  readonly session: MobileSession;
  readonly path: string;
  readonly url: string;
}

export type NativeNotificationRoute =
  | { readonly page: "home" }
  | { readonly page: "notifications" }
  | { readonly page: "post"; readonly apId: string }
  | { readonly page: "search"; readonly query: string; readonly kind: "posts" | "actors" | "auto" }
  | { readonly page: "profile"; readonly identifier: string | null };

export interface NativeNotificationRouteRequest {
  readonly session: MobileSession;
  readonly target: NativeNotificationRoute;
}

/**
 * Host paths that this app shows natively on its home screen: the feed and
 * the saved-posts preview. A Takosumi screen URL (the server's own origin)
 * lands here too.
 */
const NATIVE_HOME_PATHS = new Set(["/", "/bookmarks"]);

/**
 * Opens a host route inside the app. Recognized routes use the product
 * screen callback; unsupported routes show the home screen and are reported
 * through `onNotice`. Nothing is opened in an external browser: the host
 * session belongs to this app and there is no authenticated browser handoff,
 * so a browser would show a signed-out page.
 *
 * mobile-kit has already checked that the route is an absolute path on the
 * connected server without credentials; the origin is checked again here.
 */
export function createHostRouteHandoff(
  onNotice: (notice: HostRouteNotice | undefined) => void,
  onNativeRoute?: (request: NativeNotificationRouteRequest) => void,
): (input: HostRouteHandoffInput) => Promise<void> {
  return async ({ session, url }) => {
    const hostUrl = normalizeHostUrl(session.hostUrl);
    const target = new URL(url);
    if (target.origin !== hostUrl) {
      throw new Error("リンク先が接続中のサーバーではありません。");
    }
    if (
      target.username ||
      target.password ||
      !isSafeMobileRoutePath(`${target.pathname}${target.search}${target.hash}`)
    ) {
      throw new Error("このリンク先は開けません。");
    }
    const path = target.pathname.replace(/\/+$/u, "") || "/";
    if (NATIVE_HOME_PATHS.has(path)) {
      onNativeRoute?.({ session, target: { page: "home" } });
      onNotice(undefined);
      return;
    }
    if (onNativeRoute && path === "/notifications") {
      onNativeRoute({ session, target: { page: "notifications" } });
      onNotice(undefined);
      return;
    }
    if (onNativeRoute && path === "/search") {
      const tab = target.searchParams.get("tab");
      // The web client calls the actor tab "users". Unknown tabs stay
      // unsupported instead of silently running a different query.
      if (target.searchParams.getAll("tab").length <= 1 && target.searchParams.getAll("search").length <= 1 &&
        (tab === null || tab === "posts" || tab === "users")) {
        onNativeRoute({ session, target: { page: "search",
          query: target.searchParams.get("search") ?? "",
          kind: tab === "users" ? "actors" : tab === "posts" ? "posts" : "auto" } });
        onNotice(undefined);
        return;
      }
    }
    if (
      onNativeRoute &&
      (path === "/profile" ||
        path.startsWith("/profile/") ||
        path.startsWith("/users/"))
    ) {
      const prefix = path.startsWith("/users/") ? "/users/" : "/profile/";
      const identifier =
        path === "/profile"
          ? null
          : decodeURIComponent(path.slice(prefix.length));
      if (identifier === null || identifier.trim()) {
        onNativeRoute({ session, target: { page: "profile", identifier } });
        onNotice(undefined);
        return;
      }
    }
    if (onNativeRoute && path.startsWith("/post/")) {
      const apId = decodeURIComponent(path.slice("/post/".length));
      if (apId.trim()) {
        onNativeRoute({ session, target: { page: "post", apId } });
        onNotice(undefined);
        return;
      }
    }
    onNativeRoute?.({ session, target: { page: "home" } });
    onNotice({ hostUrl, path });
  };
}

/** The notice to show for `session`, if it belongs to that server. */
export function hostRouteNoticeFor(
  notice: HostRouteNotice | undefined,
  session: Pick<MobileSession, "hostUrl">,
): HostRouteNotice | undefined {
  if (!notice) return undefined;
  try {
    return notice.hostUrl === normalizeHostUrl(session.hostUrl)
      ? notice
      : undefined;
  } catch {
    return undefined;
  }
}

/** Path text for the notice, shortened so a long link cannot fill the screen. */
export function displayHostRoutePath(path: string): string {
  return path.length > 64 ? `${path.slice(0, 63)}…` : path;
}
