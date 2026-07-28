import { expect, test } from "bun:test";
import {
  createDirectDeployHref,
  createFirstRunActions,
  createHostCenterHref,
} from "@takosjp/mobile-kit";
import { productAdapter } from "../src/product.ts";

test("Yurucommu mobile owns the yurucommu client handoff", () => {
  expect(productAdapter.product).toBe("yurucommu");
  expect(productAdapter.mobileScheme).toBe("yurucommu");
  expect(productAdapter.directDeployUrl).toContain(
    "deploy.workers.cloudflare.com",
  );
  expect(productAdapter.strictDiscoveryProduct).toBe(true);
  expect(productAdapter.oidcScopes).toEqual(["openid", "profile"]);
  expect(productAdapter.requiredHostCapabilities).toEqual([
    "api.social.v1",
    "client.yurucommu.feed.v1",
  ]);
});

test("Yurucommu exposes manual, Cloudflare, and Takosumi setup paths", () => {
  expect(createFirstRunActions(productAdapter).map((action) => action.id)).toEqual(
    ["url", "qr", "direct-deploy", "host"],
  );
  expect(new URL(createDirectDeployHref(productAdapter)).hostname).toBe(
    "deploy.workers.cloudflare.com",
  );
  const hostCenter = new URL(
    createHostCenterHref({
      adapter: productAdapter,
      returnUri: "yurucommu://connect",
    }),
  );
  expect(hostCenter.origin + hostCenter.pathname).toBe(
    "https://app.takosumi.com/new",
  );
  expect(hostCenter.searchParams.get("product")).toBe("yurucommu");
});

test("Yurucommu mobile uses the shared foundation and public API contract", async () => {
  const pkg = (await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(pkg.dependencies?.["@takosjp/mobile-kit"]).toBe(
    "file:../mobile-kit",
  );
  expect(pkg.dependencies?.["@takosjp/yurucommu-api"]).toBe("3.4.0");
  expect(pkg.dependencies?.["takosumi-contract"]).toBeUndefined();
  expect(pkg.scripts?.bootstrap).toBe("bun install --frozen-lockfile");
});

test("Yurucommu is mobile-only and ships a restrictive CSP", async () => {
  const config = (await Bun.file(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
  ).json()) as {
    app: { security: { csp: string | null } };
    bundle: { active: boolean };
    plugins: { "deep-link": { desktop?: unknown; mobile: unknown } };
  };
  expect(config.app.security.csp).toContain("default-src 'self'");
  expect(config.app.security.csp).toContain("connect-src 'self' ipc: https:");
  expect(config.app.security.csp).not.toContain("https://*");
  expect(config.bundle.active).toBe(false);
  expect(config.plugins["deep-link"].mobile).toBeDefined();
  expect(config.plugins["deep-link"].desktop).toBeUndefined();
  expect(
    await Bun.file(
      new URL(
        "../src-tauri/capabilities/default.json",
        import.meta.url,
      ),
    ).exists(),
  ).toBe(false);
  const pkg = (await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()) as { scripts?: Record<string, string> };
  expect(pkg.scripts?.["tauri:build"]).toBe(
    "bun scripts/reject-desktop.mjs",
  );
  expect(pkg.scripts?.["tauri:dev"]).toBe("bun scripts/reject-desktop.mjs");
  expect(pkg.scripts?.doctor).toContain("--mobile-only");
  expect(pkg.scripts?.["release:native-check"]).toContain("--mobile-only");
});

test("release identity and CI use the Tauri bundle id consistently", async () => {
  const evidence = await Bun.file(
    new URL("../release/mobile-release-evidence.example.json", import.meta.url),
  ).text();
  expect(evidence).not.toContain("jp.takos.yurucommu");
  expect(JSON.parse(evidence).bundleId).toBe("com.yurucommu");
  expect(JSON.parse(evidence).store.googlePlay.packageName).toBe(
    "com.yurucommu",
  );

  const workflow = await Bun.file(
    new URL(
      "../.github/workflows/mobile-native-preflight.yml",
      import.meta.url,
    ),
  ).text();
  expect(workflow).toContain("bun run mobile:check");
  expect(workflow).toContain("bun run release:repo-check");
  expect(workflow).toMatch(
    /MOBILE_KIT_SOURCE_REF:\s*[0-9a-f]{40}/,
  );
  expect(workflow).toMatch(
    /YURUCOMMU_CORE_SOURCE_REF:\s*[0-9a-f]{40}/,
  );
});

test("Yurucommu Android identity and secure-keystore floor are product-owned", async () => {
  const config = (await Bun.file(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
  ).json()) as {
    identifier: string;
    bundle: { android: { minSdkVersion: number } };
  };
  expect(config.identifier).toBe("com.yurucommu");
  expect(config.bundle.android.minSdkVersion).toBe(28);
  const pushGradle = await Bun.file(
    new URL(
      "../src-tauri/plugins/mobile-push/android/build.gradle.kts",
      import.meta.url,
    ),
  ).text();
  expect(pushGradle).toContain("androidx.appcompat:appcompat");
});
