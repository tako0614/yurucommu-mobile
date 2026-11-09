import type { MobileSession } from "@takosjp/mobile-kit";
import type { NativeNotificationRouteRequest } from "./host-route.ts";
import { feedSessionIdentity } from "./feed-session.ts";

/** A link must not bypass an editor's save/discard controls. Closing that
 * editor only enables an explicit retry; it never replays a deferred link. */
export function createDeferredHostRoute(options: {
  session: () => MobileSession;
  isActive: () => boolean;
  isBlocked: () => boolean;
  open: (request: NativeNotificationRouteRequest) => void;
  onChange: (request: NativeNotificationRouteRequest | undefined) => void;
}) {
  let pending: NativeNotificationRouteRequest | undefined;
  let disposed = false;
  const owns = (request: NativeNotificationRouteRequest) =>
    !disposed && options.isActive() &&
    feedSessionIdentity(request.session) === feedSessionIdentity(options.session());
  const clear = () => { pending = undefined;options.onChange(undefined); };
  function receive(request: NativeNotificationRouteRequest): boolean {
    if (!owns(request)) return false;
    if (options.isBlocked()) {
      pending = request;options.onChange(request);return false;
    }
    clear();options.open(request);return true;
  }
  return {
    receive,
    retry(): boolean {
      if (!pending) return false;
      if (!owns(pending)) { clear();return false; }
      return receive(pending);
    },
    clear,
    dispose() { disposed = true;clear(); },
  };
}
