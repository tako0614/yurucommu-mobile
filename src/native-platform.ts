import type { NativeBridge } from "@takosjp/mobile-kit";

const unsupportedCapabilities: NativeBridge["capabilities"] = {
  launchPayload: false,
  launchPayloadEvents: false,
  externalBrowser: false,
  inAppBrowser: false,
  qrScanner: false,
  localNotifications: false,
  pushNotifications: false,
  biometricAuth: false,
  callIntent: false,
  clipboardText: false,
  secureStorage: false,
  persistentStorage: false,
};

export function isSupportedProductNativePlatform(value: string): boolean {
  return value === "android" || value === "ios";
}

/**
 * Desktop packages are not a supported release surface. Returning an explicit
 * no-storage bridge keeps a mistakenly launched desktop build from persisting
 * a bearer through browser storage or a non-OS-bound Stronghold password.
 */
export function createUnsupportedDesktopBridge(): NativeBridge {
  return {
    capabilities: unsupportedCapabilities,
    async getLaunchPayload() {
      return undefined;
    },
    async openExternalUrl() {
      throw new Error(
        "Yurucommu Mobile is mobile-only; use the web client on desktop.",
      );
    },
  };
}
