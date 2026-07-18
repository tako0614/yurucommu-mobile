import { expect, test } from "bun:test";
import {
  createDirectDeployHref,
  createFirstRunActions,
  createHostCenterHref,
} from "@takosjp/takosumi-mobile-kit";
import { productAdapter } from "../src/product.ts";

test("Yurucommu mobile owns the yurucommu client handoff", () => {
  expect(productAdapter.product).toBe("yurucommu");
  expect(productAdapter.mobileScheme).toBe("yurucommu");
  expect(productAdapter.directDeployUrl).toContain(
    "deploy.workers.cloudflare.com",
  );
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

test("Yurucommu mobile declares its shared source-module dependencies", async () => {
  const pkg = (await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  expect(pkg.dependencies?.["@takosjp/takosumi-mobile-kit"]).toBe(
    "file:../takosumi/mobile-kit",
  );
  expect(pkg.dependencies?.["takosumi-contract"]).toBe(
    "file:../takosumi/contract",
  );
  expect(pkg.scripts?.bootstrap).toContain("../takosumi");
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
