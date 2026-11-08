import { expect, test } from "bun:test";
import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { registerProductAndroidBack } from "../src/android-back-native.ts";
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

test("the real installed Tauri SDK registers and releases only Android Back", async () => {
  const names = ["window", "__TAURI_INTERNALS__", "__TAURI_EVENT_PLUGIN_INTERNALS__", "__TAURI_OS_PLUGIN_INTERNALS__"];
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const calls: { command: string; event: unknown; channelId: unknown }[] = [];
  let channel: Channel<unknown> | undefined, backs = 0;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "__TAURI_OS_PLUGIN_INTERNALS__", { configurable: true, value: { platform: "android" } });
    mockIPC((command, payload) => {
      const data = payload as Record<string, unknown>;
      calls.push({ command, event: data.event, channelId: data.channelId });
      if (data.handler instanceof Channel) channel = data.handler;
    });
    const release = await registerProductAndroidBack(() => { backs++; });
    expect(calls.map((call) => call.command)).toEqual(["plugin:app|register_listener"]);
    expect(calls[0]!.event).toBe("back-button");
    expect(channel).toBeDefined();
    channel!.onmessage({ canGoBack: false });
    expect(backs).toBe(1);
    await release!();
    expect(calls[1]).toEqual({ command: "plugin:app|remove_listener", event: "back-button", channelId: channel!.id });
  } finally {
    clearMocks();
    names.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test("web and iOS do not install an Android Back listener", async () => {
  expect(await registerProductAndroidBack(() => {})).toBeUndefined();
  const names = ["window", "__TAURI_INTERNALS__", "__TAURI_OS_PLUGIN_INTERNALS__"];
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "__TAURI_OS_PLUGIN_INTERNALS__", { configurable: true, value: { platform: "ios" } });
    expect(await registerProductAndroidBack(() => {})).toBeUndefined();
  } finally {
    names.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test("Back listener permissions are limited to the Android main window", async () => {
  const capability = await Bun.file(new URL("../src-tauri/capabilities/android-back.json", import.meta.url)).json();
  expect(capability.platforms).toEqual(["android"]);
  expect(capability.windows).toEqual(["main"]);
  expect(capability.permissions).toEqual(["core:app:allow-register-listener", "core:app:allow-remove-listener"]);
});
