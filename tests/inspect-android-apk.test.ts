import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectAndroidApk } from "../scripts/inspect-android-apk.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const manifest = `E: manifest
  A: package="com.yurucommu"
  E: application
    E: activity
      A: android:exported(0x01010010)=(type 0x12)0xffffffff
      E: intent-filter
        E: action
          A: android:name(0x01010003)="android.intent.action.VIEW"
        E: category
          A: android:name(0x01010003)="android.intent.category.BROWSABLE"
        E: category
          A: android:name(0x01010003)="android.intent.category.DEFAULT"
        E: data
          A: android:scheme(0x01010027)="yurucommu"
    E: service
      A: android:exported(0x01010010)=(type 0x12)0x0
      E: intent-filter
        E: action
          A: android:name(0x01010003)="com.google.firebase.MESSAGING_EVENT"
`;
const elf = "  Machine: AArch64\n  LOAD 0x000000 0x000000 0x000000 0x001000 0x001000 R E 0x4000\n";
type Reply = { status: number; stdout: string | Buffer; stderr?: string };
async function fixture(change: Partial<{ manifest: string; library: string; elf: string; signature: Reply; badging: string; align: number }> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "yuru-apk-test-")); roots.push(root);
  const apk = path.join(root, "input.apk"); await writeFile(apk, "portable process fixture; not an actual APK");
  const calls: string[][] = [], extracted: string[] = [];
  const run = (file: string, args: string[]): Reply => {
    calls.push([path.basename(file), ...args]);
    if (file.endsWith("aapt")) {
      if (args[0] === "list") return { status: 0, stdout: change.library ?? "lib/arm64-v8a/libyurucommu_mobile_lib.so\n" };
      if (args[1] === "xmltree") return { status: 0, stdout: change.manifest ?? manifest };
      return { status: 0, stdout: change.badging ?? "package: name='com.yurucommu' versionCode='1' versionName='0.1.0'\nnative-code: 'arm64-v8a'\n" };
    }
    if (file.endsWith("apksigner")) return change.signature ?? { status: 1, stdout: "DOES NOT VERIFY", stderr: "ERROR: Missing META-INF/MANIFEST.MF" };
    if (file.endsWith("zipalign")) return { status: change.align ?? 0, stdout: "" };
    if (file === "unzip") return { status: 0, stdout: Buffer.from("fixture native bytes") };
    if (file === "readelf") {
      const output = args.at(-1)!; extracted.push(output);
      expect(readFileSync(output).toString()).toBe("fixture native bytes");
      return { status: 0, stdout: change.elf ?? elf };
    }
    throw new Error(`Unexpected process ${file}`);
  };
  return { apk, buildTools: root, run, calls, extracted };
}

test("static inspection reports unsigned explicitly and cleans extracted files", async () => {
  const input = await fixture(); const report = await inspectAndroidApk(input);
  expect(report.ok).toBe(true); expect(report.signature).toBe("unsigned"); expect(report.releaseQualified).toBe(false);
  expect(input.extracted.length).toBe(1); expect(input.extracted.every((file) => !existsSync(file))).toBe(true);
  expect(input.calls.filter(([file]) => file === "apksigner").length).toBe(1);
});

test("an APK containing only another native library cannot stand in for the App", async () => {
  const input = await fixture({ library: "lib/arm64-v8a/libsome_sdk.so\n" });
  const report = await inspectAndroidApk(input);
  expect(report.ok).toBe(false); expect(report.issues.join(" ")).toContain("App native library");
});

test("the package mentioning yurucommu cannot replace the exact VIEW scheme", async () => {
  const input = await fixture({ manifest: manifest.replace('android:scheme(0x01010027)="yurucommu"', 'android:scheme(0x01010027)="another-app"') });
  const report = await inspectAndroidApk(input);
  expect(report.ok).toBe(false); expect(report.issues.join(" ")).toContain("scheme yurucommu");
});

test("an exported FCM service and a debuggable release are rejected", async () => {
  const input = await fixture({ manifest: manifest.replace("E: application", "E: application\n    A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff").replace("(type 0x12)0x0", "(type 0x12)0xffffffff") });
  const report = await inspectAndroidApk(input);
  expect(report.ok).toBe(false); expect(report.issues.join(" ")).toContain("debuggable"); expect(report.issues.join(" ")).toContain("must not be exported");
});

test("wrong product metadata stops before archive extraction", async () => {
  const input = await fixture({ badging: "package: name='com.other' versionName='0.1.0'\n" });
  const report = await inspectAndroidApk(input);
  expect(report.ok).toBe(false); expect(input.calls.length).toBe(1); expect(input.extracted.length).toBe(0);
});

test("an unsigned APK fails the explicit signature requirement", async () => {
  const input = await fixture(); const report = await inspectAndroidApk({ ...input, requireSigned: true });
  expect(report.ok).toBe(false); expect(report.issues).toContain("A verified APK signature is required");
});

test("a broken signature is not classified as an unsigned artifact", async () => {
  const input = await fixture({ signature: { status: 1, stdout: "DOES NOT VERIFY", stderr: "Signer signature did not verify" } });
  const report = await inspectAndroidApk(input);
  expect(report.ok).toBe(false); expect(report.signature).toBe("unknown");
});

test("missing manifest mixed with another signature error is not unsigned", async () => {
  const input = await fixture({ signature: { status: 1, stdout: "DOES NOT VERIFY\nAPK Signature Scheme v2 signer did not verify", stderr: "ERROR: Missing META-INF/MANIFEST.MF" } });
  const report = await inspectAndroidApk(input);
  expect(report.ok).toBe(false); expect(report.signature).toBe("unknown");
});

test("known JVM notices do not turn other exit statuses into unsigned", async () => {
  const notices = "WARNING: A restricted method in java.lang.System has been called\nWARNING: java.lang.System::loadLibrary has been called by org.conscrypt.NativeLibraryUtil in an unnamed module (file:/sdk/lib/apksigner.jar)\nWARNING: Use --enable-native-access=ALL-UNNAMED to avoid a warning for callers in this module\nWARNING: Restricted methods will be blocked in a future release unless native access is enabled\n";
  for (const status of [1, 2]) {
    const input = await fixture({ signature: { status, stdout: "DOES NOT VERIFY", stderr: notices + "ERROR: Missing META-INF/MANIFEST.MF" } });
    const report = await inspectAndroidApk(input);
    expect(report.ok).toBe(status === 1); expect(report.signature).toBe(status === 1 ? "unsigned" : "unknown");
  }
});

test("ZIP or ELF alignment and architecture failures are not skipped", async () => {
  const input = await fixture({ align: 1, elf: elf.replace("AArch64", "ARM").replace("0x4000", "0x1000") });
  const report = await inspectAndroidApk(input);
  expect(report.ok).toBe(false); expect(report.issues.join(" ")).toContain("ZIP entries"); expect(report.issues.join(" ")).toContain("native machine");
});

test("a failed SDK command never becomes a passing empty inspection", async () => {
  const input = await fixture();
  await expect(inspectAndroidApk({ ...input, run: () => ({ status: 2, stdout: "", stderr: "bad APK" }) })).rejects.toThrow("exited 2");
});

test("duplicate or traversing native entries are rejected", async () => {
  for (const library of ["lib/arm64-v8a/libyurucommu_mobile_lib.so\nlib/arm64-v8a/libyurucommu_mobile_lib.so\n", "lib/../escape.so\n"]) {
    const input = await fixture({ library }); const report = await inspectAndroidApk(input);
    expect(report.ok).toBe(false);
    if (library.includes("..")) expect(input.calls.some(([file]) => file === "unzip")).toBe(false);
  }
});

test("metadata must refer to the same APK bytes throughout inspection", async () => {
  const input = await fixture();
  const report = await inspectAndroidApk({ ...input, run(file, args) {
    const result = input.run(file, args);
    if (file === "readelf") writeFileSync(input.apk, "a different APK");
    return result;
  } });
  expect(report.ok).toBe(false); expect(report.issues).toContain("APK changed during inspection");
});

test("help requires neither SDK nor signing inputs", () => {
  const result = Bun.spawnSync([process.execPath, path.resolve("scripts/inspect-android-apk.mjs"), "--help"], { env: { PATH: "" } });
  expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain("not the native release or device gate");
});
