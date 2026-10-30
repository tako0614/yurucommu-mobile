import { normalizeHostUrl, type MobileSession } from "@takosjp/mobile-kit";

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

/**
 * Host paths that this app shows natively on its home screen: the feed and
 * the saved-posts preview. A Takosumi screen URL (the server's own origin)
 * lands here too.
 */
const NATIVE_HOME_PATHS = new Set(["/", "/bookmarks"]);

/**
 * Opens a host route inside the app. Routes with a native screen show the
 * home screen; any other route also stays on the home screen and is reported
 * through `onNotice`. Nothing is opened in an external browser: the host
 * session belongs to this app and there is no authenticated browser handoff,
 * so a browser would show a signed-out page.
 *
 * mobile-kit has already checked that the route is an absolute path on the
 * connected server without credentials; the origin is checked again here.
 */
export function createHostRouteHandoff(
  onNotice: (notice: HostRouteNotice | undefined) => void,
): (input: HostRouteHandoffInput) => Promise<void> {
  return async ({ session, url }) => {
    const hostUrl = normalizeHostUrl(session.hostUrl);
    const target = new URL(url);
    if (target.origin !== hostUrl) {
      throw new Error("リンク先が接続中のサーバーではありません。");
    }
    const path = target.pathname.replace(/\/+$/u, "") || "/";
    onNotice(NATIVE_HOME_PATHS.has(path) ? undefined : { hostUrl, path });
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
