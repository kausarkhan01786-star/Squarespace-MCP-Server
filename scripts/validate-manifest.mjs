import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

export function validateArtifactManifest(binaryPath, manifestPath) {
  if (!existsSync(binaryPath)) {
    throw new Error(`Binary file not found at: ${binaryPath}`);
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse manifest JSON: ${err.message}`);
  }

  if (manifest.artifactType !== "development-build-artifact") {
    throw new Error(`Invalid artifactType: expected 'development-build-artifact', got '${manifest.artifactType}'`);
  }

  if (manifest.architecture !== "x64") {
    throw new Error(`Architecture mismatch: expected 'x64', got '${manifest.architecture}'`);
  }

  if (manifest.nodeApiVersion !== 8) {
    throw new Error(`Node-API version mismatch: expected 8, got ${manifest.nodeApiVersion}`);
  }

  // Verify SHA-256
  const binaryBytes = readFileSync(binaryPath);
  const actualSha256 = createHash("sha256").update(binaryBytes).digest("hex");
  if (actualSha256.toLowerCase() !== manifest.sha256Digest?.toLowerCase()) {
    throw new Error(
      `SHA-256 digest mismatch! Manifest: ${manifest.sha256Digest}, Actual: ${actualSha256}`
    );
  }

  // Verify commit if running inside git checkout
  let currentCommit = "";
  try {
    currentCommit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    // not in git repository or git unavailable
  }

  if (currentCommit && manifest.sourceCommit && manifest.sourceCommit !== "unknown") {
    if (manifest.sourceCommit !== currentCommit) {
      throw new Error(
        `Source commit mismatch: manifest commit '${manifest.sourceCommit}' does not match current commit '${currentCommit}'.`
      );
    }
  }

  console.log(`[manifest-validation] SUCCESS: Manifest and binary checksum verified for commit ${manifest.sourceCommit}`);
}

const defaultBinary = resolve(process.cwd(), "build", "Release", "instance_ownership.node");
const defaultManifest = resolve(process.cwd(), "build", "Release", "build-manifest.json");

if (process.argv[1]?.endsWith("validate-manifest.mjs")) {
  validateArtifactManifest(defaultBinary, defaultManifest);
}
