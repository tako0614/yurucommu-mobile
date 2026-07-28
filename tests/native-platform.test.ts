import { expect, test } from "bun:test";
import {
  createUnsupportedDesktopBridge,
  isSupportedProductNativePlatform,
} from "../src/native-platform.ts";

test("Yurucommu supports only iOS and Android native runtimes", () => {
  expect(isSupportedProductNativePlatform("ios")).toBe(true);
  expect(isSupportedProductNativePlatform("android")).toBe(true);
  expect(isSupportedProductNativePlatform("linux")).toBe(false);
  expect(isSupportedProductNativePlatform("macos")).toBe(false);
  expect(isSupportedProductNativePlatform("windows")).toBe(false);
});

test("unsupported desktop runtimes expose no credential storage", async () => {
  const bridge = createUnsupportedDesktopBridge();
  expect(bridge.capabilities.secureStorage).toBe(false);
  expect(bridge.capabilities.persistentStorage).toBe(false);
  expect(bridge.secureStore).toBeUndefined();
  expect(bridge.storage).toBeUndefined();
  await expect(bridge.openExternalUrl("https://accounts.example")).rejects.toThrow(
    "mobile-only",
  );
});
