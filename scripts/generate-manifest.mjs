import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

export function generateManifest() {
  const binaryPath = resolve(process.cwd(), "build", "Release", "instance_ownership.node");
  if (!existsSync(binaryPath)) {
    console.error(`[manifest] Cannot generate manifest: binary not found at ${binaryPath}`);
    process.exit(1);
  }

  const binaryBuffer = readFileSync(binaryPath);
  const sha256 = createHash("sha256").update(binaryBuffer).digest("hex");

  let commit = "unknown";
  try {
    commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    commit = process.env.GITHUB_SHA || "unknown";
  }

  const runnerImage = process.env.RUNNER_IMAGE_VERSION || process.env.ImageVersion || process.env.RUNNER_OS || "windows-2022";
  const msvcVersion = process.env.MSVC_VERSION || "MSVC-v143";
  const windowsSdkVersion = process.env.WIN_SDK_VERSION || "10.0.20348.0";

  const manifest = {
    artifactType: "development-build-artifact",
    description: "Non-production development artifact for Windows native single-instance ownership",
    sourceCommit: commit,
    nodeVersion: process.version,
    nodeApiVersion: 8,
    architecture: process.arch,
    platform: process.platform,
    runnerImage,
    msvcVersion,
    windowsSdkVersion,
    sha256Digest: sha256,
    timestamp: new Date().toISOString(),
  };

  const manifestPath = resolve(process.cwd(), "build", "Release", "build-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`[manifest] Build manifest generated at ${manifestPath}`);
  console.log(JSON.stringify(manifest, null, 2));
}

generateManifest();
