#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMobileReleaseIdentity } from "../../mobile-kit/scripts/mobile-release-identity.mjs";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const HELP = `Inspect a Yurucommu Android APK without signing, installing, or publishing it.

Usage: bun run inspect:android-apk -- <apk> --build-tools <Android build-tools directory>
       [--require-signed] [--readelf <executable>]

Requires aapt, apksigner, zipalign, unzip, and readelf. Expected identity and
deep-link schemes come from this product's source. --require-signed requires a
valid APK signature; it does not establish the publisher's signing identity.
This is a static inspection, not the native release or device gate.
`;

function processClient(file, args, binary = false) {
  const result = spawnSync(file, args, {
    encoding: binary ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${path.basename(file)}: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function xmlTree(source) {
  const root = { tag: "root", attrs: {}, children: [] };
  const stack = [{ indent: -1, node: root }];
  for (const line of source.split(/\r?\n/u)) {
    const element = /^(\s*)E: ([^ (]+)/u.exec(line);
    if (element) {
      const indent = element[1].length;
      while (stack.at(-1).indent >= indent) stack.pop();
      const node = { tag: element[2], attrs: {}, children: [] };
      stack.at(-1).node.children.push(node);
      stack.push({ indent, node });
      continue;
    }
    const attribute = /^\s*A: ([^(\s=]+)(?:\([^)]*\))?=(.*)$/u.exec(line);
    if (!attribute) continue;
    const quoted = /^("(?:\\.|[^"\\])*")/u.exec(attribute[2]);
    stack.at(-1).node.attrs[attribute[1]] = quoted
      ? JSON.parse(quoted[1])
      : attribute[2].trim();
  }
  return root;
}

function descendants(node, tag) {
  return node.children.flatMap((child) => [
    ...(child.tag === tag ? [child] : []),
    ...descendants(child, tag),
  ]);
}

function booleanAttribute(value, fallback) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  const number = /\(type 0x12\)(0x[0-9a-f]+)$/iu.exec(value);
  if (number) return BigInt(number[1]) !== 0n;
  throw new Error("Unrecognized Android boolean attribute");
}

function named(filter, tag, name) {
  return filter.children.some((node) => node.tag === tag && node.attrs["android:name"] === name);
}

function knownUnsigned(result) {
  if (result.status !== 1) return false;
  // These JVM notices accompany the installed SDK, not signature failures.
  const jvmNotices = [
    /^WARNING: A restricted method in java\.lang\.System has been called$/u,
    /^WARNING: java\.lang\.System::loadLibrary has been called by org\.conscrypt\.NativeLibraryUtil in an unnamed module \(file:.+\)$/u,
    /^WARNING: Use --enable-native-access=ALL-UNNAMED to avoid a warning for callers in this module$/u,
    /^WARNING: Restricted methods will be blocked in a future release unless native access is enabled$/u,
  ];
  const lines = (String(result.stdout) + "\n" + String(result.stderr ?? "")).split(/\r?\n/u)
    .map((line) => line.trim()).filter((line) => line && !jvmNotices.some((notice) => notice.test(line)));
  return lines.length === 2 && lines[0] === "DOES NOT VERIFY" && lines[1] === "ERROR: Missing META-INF/MANIFEST.MF";
}

function manifestIssues(source, schemes) {
  const tree = xmlTree(source);
  const applications = descendants(tree, "application");
  if (applications.length !== 1) return ["APK must declare exactly one application"];
  const application = applications[0];
  const issues = [];
  if (booleanAttribute(application.attrs["android:debuggable"], false)) issues.push("Release APK is debuggable");
  for (const scheme of schemes) {
    const registered = application.children.some((activity) =>
      ["activity", "activity-alias"].includes(activity.tag) &&
      booleanAttribute(activity.attrs["android:exported"], false) &&
      activity.children.some((filter) =>
        filter.tag === "intent-filter" &&
        named(filter, "action", "android.intent.action.VIEW") &&
        named(filter, "category", "android.intent.category.BROWSABLE") &&
        named(filter, "category", "android.intent.category.DEFAULT") &&
        filter.children.some((node) => node.tag === "data" && node.attrs["android:scheme"] === scheme),
      ),
    );
    if (!registered) issues.push(`Missing exported VIEW intent for scheme ${scheme}`);
  }
  const messaging = application.children.filter((node) => node.tag === "service" &&
    node.children.some((filter) => filter.tag === "intent-filter" && named(filter, "action", "com.google.firebase.MESSAGING_EVENT")));
  if (!messaging.length) issues.push("FCM messaging service intent is missing");
  if (messaging.some((service) => booleanAttribute(service.attrs["android:exported"], true))) issues.push("FCM messaging service must not be exported");
  return issues;
}

/** SDK process injection is for portable tests; the CLI always uses real tools. */
export async function inspectAndroidApk({ apk, buildTools, readelf = "readelf", requireSigned = false, run = processClient }) {
  const identity = inspectMobileReleaseIdentity(appDir);
  if (identity.issues.length) throw new Error(identity.issues.map((issue) => issue.detail).join("; "));
  const version = identity.tauriConfig.version;
  if (typeof version !== "string" || !version) throw new Error("Product has no release version");
  const cargo = Bun.TOML.parse(await readFile(path.join(appDir, "src-tauri/Cargo.toml"), "utf8"));
  const library = cargo.lib?.name;
  if (typeof library !== "string" || !/^[A-Za-z0-9_]+$/u.test(library)) throw new Error("Product has no valid Cargo library name");
  const appLibrary = `lib${library}.so`;
  const schemes = [...new Set((identity.tauriConfig.plugins?.["deep-link"]?.mobile ?? []).flatMap((entry) => entry.scheme ?? []))];
  if (!schemes.length || schemes.some((scheme) => typeof scheme !== "string" || !scheme)) throw new Error("Product has no valid mobile deep-link scheme");
  const file = path.resolve(apk);
  if (!(await stat(file)).isFile()) throw new Error("APK must be a regular file");
  const report = { kind: "yurucommu.android-apk-inspection@v1", apk: file, sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
    expected: { bundleId: identity.bundleId, version, schemes, appLibrary }, signature: "unknown", native: [], issues: [], releaseQualified: false,
    limits: "Static inspection only; authorized signer, device, OIDC, push delivery, store and deployed service are not verified." };
  const executable = (name) => path.join(path.resolve(buildTools), name + (process.platform === "win32" ? name === "apksigner" ? ".bat" : ".exe" : ""));
  function command(program, args, binary = false) {
    const result = run(program, args, binary);
    if (!result || !Number.isInteger(result.status)) throw new Error(`${path.basename(program)} did not return an exit status`);
    return result;
  }
  function success(program, args, binary = false) {
    const result = command(program, args, binary);
    if (result.status !== 0) throw new Error(`${path.basename(program)} exited ${result.status}: ${String(result.stderr ?? "").slice(0, 1000)}`);
    return result.stdout;
  }
  const badging = String(success(executable("aapt"), ["dump", "badging", file]));
  const packageLine = /^package: name='([^']+)'[^\n]* versionName='([^']+)'/mu.exec(badging);
  if (!packageLine || packageLine[1] !== identity.bundleId || packageLine[2] !== version) {
    report.issues.push("APK package or version does not match product source");
    return { ...report, ok: false };
  }
  report.issues.push(...manifestIssues(String(success(executable("aapt"), ["dump", "xmltree", file, "AndroidManifest.xml"])), schemes));
  const signed = command(executable("apksigner"), ["verify", "--verbose", file]);
  if (signed.status === 0) report.signature = "verified";
  else if (knownUnsigned(signed)) report.signature = "unsigned";
  else report.issues.push("APK signature verification failed");
  if (requireSigned && report.signature !== "verified") report.issues.push("A verified APK signature is required");
  const aligned = command(executable("zipalign"), ["-c", "-P", "16", "4", file]);
  if (aligned.status !== 0) report.issues.push("APK ZIP entries are not 16 KiB aligned");
  const entries = String(success(executable("aapt"), ["list", file])).split(/\r?\n/u).filter(Boolean);
  const libraries = entries.filter((name) => name.startsWith("lib/") && name.endsWith(".so"));
  if (!libraries.length) report.issues.push("APK has no native libraries");
  if (new Set(libraries).size !== libraries.length) report.issues.push("Duplicate native archive entries");
  const abis = [...new Set(libraries.map((name) => name.split("/")[1]))];
  for (const abi of abis) if (!libraries.includes(`lib/${abi}/${appLibrary}`)) report.issues.push(`App native library is missing for ${abi}`);
  const declared = [...(badging.match(/^native-code:\s*(.*)$/mu)?.[1] ?? "").matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  if (JSON.stringify([...declared].sort()) !== JSON.stringify([...abis].sort())) report.issues.push("APK declared and packaged native ABIs disagree");
  const machines = { "arm64-v8a": "AArch64", "armeabi-v7a": "ARM", x86: "Intel 80386", x86_64: "Advanced Micro Devices X86-64" };
  const scratch = await mkdtemp(path.join(tmpdir(), "yurucommu-apk-inspection-"));
  try {
    for (const [index, name] of libraries.entries()) {
      const entry = /^lib\/([^/]+)\/[A-Za-z0-9_.+-]+\.so$/u.exec(name);
      if (!entry || !machines[entry[1]]) { report.issues.push(`Unsupported native library entry: ${name}`); continue; }
      const bytes = success("unzip", ["-p", file, name], true);
      const extracted = path.join(scratch, `${index}.so`);
      await writeFile(extracted, bytes, { mode: 0o600, flag: "wx" });
      const elf = String(success(readelf, ["-W", "-h", "-l", extracted]));
      const machine = /^\s*Machine:\s*(.+)$/mu.exec(elf)?.[1]?.trim();
      const loads = elf.split(/\r?\n/u).filter((line) => /^\s*LOAD\s/u.test(line)).map((line) => line.trim().split(/\s+/u));
      const loadAligned = loads.length > 0 && loads.every((row) => {
        const align = row.at(-1);
        if (![row[1], row[2], align].every((value) => /^0x[0-9a-f]+$/iu.test(value ?? ""))) return false;
        const size = BigInt(align);
        return size >= 16384n && size % 16384n === 0n && BigInt(row[1]) % size === BigInt(row[2]) % size;
      });
      if (machine !== machines[entry[1]] || !loadAligned) report.issues.push(`Invalid native machine or 16 KiB LOAD alignment: ${name}`);
      report.native.push({ entry: name, machine, loadAligned, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
  if (createHash("sha256").update(await readFile(file)).digest("hex") !== report.sha256) report.issues.push("APK changed during inspection");
  return { ...report, ok: report.issues.length === 0 };
}

export async function main(args = process.argv.slice(2)) {
  args = [...args];
  if (args[0] === "--") args.shift();
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return 0; }
  const options = { apk: args.shift() };
  while (args.length) {
    const flag = args.shift();
    if (flag === "--require-signed") options.requireSigned = true;
    else if (["--build-tools", "--readelf"].includes(flag) && args.length) options[flag === "--build-tools" ? "buildTools" : "readelf"] = args.shift();
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!options.apk || !options.buildTools) throw new Error(HELP);
  const report = await inspectAndroidApk(options);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
