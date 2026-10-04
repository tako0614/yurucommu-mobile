import type { MobileSession } from "@takosjp/mobile-kit";

export function snapshotFeedSession(session: MobileSession): MobileSession {
  return {
    ...session,
    productEndpoints: session.productEndpoints ? { ...session.productEndpoints } : undefined,
  };
}

export function feedSessionIdentity(session: MobileSession): string {
  return JSON.stringify([
    session.hostUrl, session.product, session.accessToken,
    session.tokenType, session.createdAt, session.oidcIssuer, session.oidcClientId,
    Object.entries(session.productEndpoints ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
