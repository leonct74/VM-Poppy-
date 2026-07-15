#!/usr/bin/env node
/**
 * Build the VM-Poppy backend into a single self-contained executable, so the poppy
 * can be listed and end users never need Node installed. Mirrors MailPoppy's proven
 * pipeline (the reference the AgentsPoppy guidelines point to).
 *
 * Pipeline: esbuild (bundle ESM + AWS SDK v3 → one CJS) → Node SEA (Single
 * Executable Application) → macOS: lipo-thin + strip signature + postject inject +
 * ad-hoc codesign. Output: backend/vmpoppy-sidecar (= manifest.backend.entry).
 *
 * Run from the repo root:  npm run build:sidecar
 */
import * as esbuild from "esbuild";
import { inject } from "postject";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendRoot = join(root, "backend");
const buildDir = join(backendRoot, "build");

// Cross-target: `--win32` (or VMPOPPY_TARGET_PLATFORM=win32) builds the Windows
// sidecar FROM macOS/Linux — the SEA blob is platform-portable (no code cache /
// snapshot), so it's injected into the official win-x64 node.exe of the SAME
// version as the node running this script (blob/base versions must match).
const targetWin32 = process.argv.includes("--win32") || process.env.VMPOPPY_TARGET_PLATFORM === "win32";
const outBin = join(backendRoot, targetWin32 ? "vmpoppy-sidecar.exe" : "vmpoppy-sidecar"); // = extension.json backend.entry (+.exe on Windows)

// Node's stable SEA fuse sentinel (nodejs.org/api/single-executable-applications).
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

/** The machine's TRUE hardware arch — robust under Rosetta (where `uname -m` lies). */
function nativeArch() {
  if (process.platform !== "darwin") return process.arch === "arm64" ? "arm64" : "x86_64";
  try {
    if (execFileSync("sysctl", ["-n", "hw.optional.arm64"]).toString().trim() === "1") return "arm64";
  } catch {
    /* intel Macs have no such key */
  }
  return "x86_64";
}

/** lipo arch slices of a Mach-O binary (empty on failure / non-darwin). */
function archSlices(bin) {
  try {
    return execFileSync("lipo", ["-archs", bin]).toString().trim().split(/\s+/);
  } catch {
    return [];
  }
}

/**
 * esbuild is installed for x86_64 here, and the base node must contain the target
 * (native) slice. Both hold when we run under the x86_64 slice of a UNIVERSAL node.
 * If we're not already there, re-exec under one (Rosetta) — so `npm run build:sidecar`
 * works with no manual `arch -x86_64 …` incantation.
 */
function ensureBuildableNode() {
  if (process.platform !== "darwin" || process.env.VMPOPPY_REEXEC) return;
  const target = process.env.VMPOPPY_TARGET_ARCH || nativeArch();
  const ok = process.arch === "x64" && archSlices(process.execPath).includes(target);
  if (ok) return;
  const universal = ["/usr/local/bin/node", "/opt/homebrew/bin/node"].find(
    (p) => existsSync(p) && archSlices(p).includes(target) && archSlices(p).includes("x86_64"),
  );
  if (!universal) {
    throw new Error(
      `Need a universal (x86_64+${target}) node to build the sidecar; none found at /usr/local/bin/node or /opt/homebrew/bin/node. ` +
        `Install one (e.g. the official macOS .pkg), or run: arch -x86_64 <universal-node> scripts/build-sidecar.mjs`,
    );
  }
  console.log(`[reexec] rebuilding under ${universal} (x86_64 slice) to base a native ${target} binary`);
  execFileSync("arch", ["-x86_64", universal, fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, VMPOPPY_REEXEC: "1" },
  });
  process.exit(0);
}

/**
 * Fetch (and cache) the official Windows x64 node of THIS node's exact version,
 * integrity-checked against nodejs.org's SHASUMS256.txt. Returns the node.exe path.
 */
function fetchWindowsNode() {
  const v = process.versions.node; // blob generator and SEA base MUST match versions
  const name = `node-v${v}-win-x64`;
  const cacheDir = join(buildDir, "node-cache");
  const exePath = join(cacheDir, `${name}-node.exe`);
  if (existsSync(exePath)) return exePath;
  mkdirSync(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, `${name}.zip`);
  const base = `https://nodejs.org/dist/v${v}`;
  console.log(`[win32] downloading ${base}/${name}.zip`);
  run("curl", ["-fsSL", "-o", zipPath, `${base}/${name}.zip`]);
  // Verify against the official checksum list before touching the archive.
  const sums = execFileSync("curl", ["-fsSL", `${base}/SHASUMS256.txt`]).toString();
  const expected = sums.split("\n").find((l) => l.trim().endsWith(`${name}.zip`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`no SHASUMS256 entry for ${name}.zip`);
  const actual = execFileSync("shasum", ["-a", "256", zipPath]).toString().split(/\s+/)[0];
  if (actual !== expected) throw new Error(`checksum mismatch for ${name}.zip: got ${actual}, expected ${expected}`);
  console.log(`[win32] sha256 verified: ${actual}`);
  run("unzip", ["-j", "-o", "-q", zipPath, `${name}/node.exe`, "-d", cacheDir]);
  copyFileSync(join(cacheDir, "node.exe"), exePath);
  return exePath;
}

async function main() {
  if (!targetWin32) ensureBuildableNode();
  const bundlePath = join(buildDir, "sidecar.cjs");
  const blobPath = join(buildDir, "sidecar.blob");
  const seaConfigPath = join(buildDir, "sea-config.json");
  mkdirSync(buildDir, { recursive: true });

  // 1. Bundle the backend + AWS SDK v3 into one CJS file (SEA runs CJS).
  console.log("[1/5] esbuild bundle →", bundlePath);
  await esbuild.build({
    entryPoints: [join(backendRoot, "src", "server.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: bundlePath,
    logLevel: "warning",
  });

  // 2. Generate the SEA preparation blob from the bundle.
  console.log("[2/5] SEA blob →", blobPath);
  writeFileSync(
    seaConfigPath,
    JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true, useCodeCache: false }, null, 2),
  );
  run(process.execPath, ["--experimental-sea-config", seaConfigPath]);

  // 3. Stage the Node binary as the SEA base. Target the MACHINE's native arch
  //    (not the build process's arch) so a build run under Rosetta (x86_64 node on
  //    an arm64 Mac) still yields a native arm64 sidecar. The base node must be the
  //    SAME major version as the blob generator (step 2) — run this with a node whose
  //    version matches and whose binary contains the target slice (a universal node
  //    is ideal), e.g.  arch -x86_64 /usr/local/bin/node scripts/build-sidecar.mjs
  console.log("[3/5] stage node binary →", outBin);
  const targetArch = process.env.VMPOPPY_TARGET_ARCH || nativeArch();
  if (targetWin32) {
    copyFileSync(fetchWindowsNode(), outBin);
  } else if (process.platform === "darwin") {
    const slices = execFileSync("lipo", ["-archs", process.execPath]).toString().trim().split(/\s+/);
    if (!slices.includes(targetArch)) {
      throw new Error(
        `The node used to build (${process.execPath}) has no ${targetArch} slice (has: ${slices.join(", ")}). ` +
          `Run with a ${targetArch}-capable, version-matched node, e.g. \`arch -x86_64 /usr/local/bin/node scripts/build-sidecar.mjs\`.`,
      );
    }
    if (slices.length > 1) run("lipo", [process.execPath, "-thin", targetArch, "-output", outBin]);
    else copyFileSync(process.execPath, outBin);
  } else {
    copyFileSync(process.execPath, outBin);
  }
  chmodSync(outBin, 0o755);

  // 4. macOS targets: strip the existing signature before injecting the blob.
  //    (PE/Windows binaries carry no Mach-O signature — nothing to strip.)
  if (!targetWin32 && process.platform === "darwin") {
    console.log("[4/5] codesign --remove-signature");
    run("codesign", ["--remove-signature", outBin]);
  } else {
    console.log("[4/5] (no signature to strip for this target)");
  }

  // 5. Inject the SEA blob; re-sign ad-hoc on macOS targets so macOS will run it.
  console.log("[5/5] postject inject" + (!targetWin32 && process.platform === "darwin" ? " + re-sign" : ""));
  await inject(outBin, "NODE_SEA_BLOB", readFileSync(blobPath), {
    sentinelFuse: SEA_FUSE,
    machoSegmentName: !targetWin32 && process.platform === "darwin" ? "NODE_SEA" : undefined,
  });
  if (!targetWin32 && process.platform === "darwin") run("codesign", ["--sign", "-", outBin]);

  console.log(`\n✅ sidecar binary ready: ${outBin}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
