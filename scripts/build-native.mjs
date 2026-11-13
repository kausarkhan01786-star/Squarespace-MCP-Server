import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const TARGET_PLATFORM = "win32";
const TARGET_ARCH = "x64";
const TARGET_NODE_VERSION = "26.8.1";

export function buildNative() {
  console.log(`[native-build] Checking build environment...`);
  console.log(`[native-build] Platform: ${process.platform} (expected: ${TARGET_PLATFORM})`);
  console.log(`[native-build] Architecture: ${process.arch} (expected: ${TARGET_ARCH})`);
  console.log(`[native-build] Current Node.js: ${process.version} (target: v${TARGET_NODE_VERSION})`);

  if (process.platform !== TARGET_PLATFORM) {
    console.error(
      `[native-build] ERROR: Windows native single-instance ownership requires platform '${TARGET_PLATFORM}'. Current platform is '${process.platform}'.`
    );
    process.exit(1);
  }

  if (process.arch !== TARGET_ARCH) {
    console.error(
      `[native-build] ERROR: Addon build requires '${TARGET_ARCH}'. Current architecture is '${process.arch}'.`
    );
    process.exit(1);
  }

  // Check if cl.exe is present on PATH
  const clCheck = spawnSync("where.exe", ["cl.exe"], { encoding: "utf8" });
  if (clCheck.status !== 0) {
    console.log("[native-build] Notice: 'cl.exe' was not found on PATH. Attempting node-gyp detection of Visual Studio...");
  }

  const nodeGypBin = resolve(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "node-gyp.cmd" : "node-gyp"
  );

  const command = existsSync(nodeGypBin) ? nodeGypBin : "npx node-gyp";

  console.log(`[native-build] Executing: ${command} rebuild --arch=x64`);
  const buildResult = spawnSync(
    command,
    ["rebuild", "--arch=x64"],
    {
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
      },
    }
  );

  if (buildResult.status !== 0) {
    console.error(`\n[native-build] BUILD FAILED with exit code ${buildResult.status}.`);
    console.error(
      "[native-build] Cause: MSVC compiler, Windows SDK, or Visual Studio Build Tools are unavailable on this system.\n" +
      "[native-build] Notice: The local developer machine does not require Visual Studio Build Tools.\n" +
      "[native-build] Addon compilation and tests are executed on GitHub Actions windows-2022 runners."
    );
    process.exit(buildResult.status ?? 1);
  }

  const binaryPath = resolve(process.cwd(), "build", "Release", "instance_ownership.node");
  if (!existsSync(binaryPath)) {
    console.error(`[native-build] ERROR: Build exited cleanly but output binary was not found at: ${binaryPath}`);
    process.exit(1);
  }

  console.log(`[native-build] SUCCESS: Addon built at ${binaryPath}`);
}

buildNative();
