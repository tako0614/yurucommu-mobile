import { onBackButtonPress } from "@tauri-apps/api/app";
import { platform } from "@tauri-apps/plugin-os";
import { detectTauriRuntime } from "@takosjp/mobile-kit";
import type { AndroidBackRegistrar } from "./android-back-navigation.ts";

export const registerProductAndroidBack: AndroidBackRegistrar = async (handler) => {
  if (!detectTauriRuntime() || platform() !== "android") return undefined;
  const listener = await onBackButtonPress(handler);
  return () => listener.unregister();
};
