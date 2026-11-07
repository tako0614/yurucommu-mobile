export interface ProcessResult {
  status: number | null;
  stdout: string | Uint8Array | null;
  stderr?: string | Uint8Array | null;
}

export interface ApkInspection {
  kind: "yurucommu.android-apk-inspection@v1";
  apk: string;
  sha256: string;
  expected: { bundleId: string; version: string; schemes: string[]; appLibrary: string };
  signature: "unknown" | "unsigned" | "verified";
  native: { entry: string; machine?: string; loadAligned: boolean; sha256: string }[];
  issues: string[];
  releaseQualified: false;
  limits: string;
  ok: boolean;
}

export function inspectAndroidApk(options: {
  apk: string;
  buildTools: string;
  readelf?: string;
  requireSigned?: boolean;
  run?: (file: string, args: string[], binary?: boolean) => ProcessResult;
}): Promise<ApkInspection>;

export function main(args?: string[]): Promise<number>;
