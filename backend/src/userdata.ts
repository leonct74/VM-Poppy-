// Pure generation of the first-boot install script (user-data), for Linux and Windows.
// No AWS, no IO — fully unit-testable. See DESIGN.md §7.
//
// It: installs the declared software with the right package manager, runs the optional
// setup script, schedules a TTL self-shutdown for "ephemeral" configs, and prints the
// INSTALL_SENTINEL to the SERIAL CONSOLE so the backend can detect "ready" via
// GetConsoleOutput — with no instance IAM role and no SSH-key custody.

import { INSTALL_SENTINEL, PKG_RESULT_PREFIX, type PackageOutcome, type VmConfig } from "./types";

/** Reject anything that isn't a plausible package token, so the list can't inject shell. */
const SAFE_PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function sanitizePackages(software: string[]): string[] {
  return software.map((s) => s.trim()).filter((s) => s.length > 0 && SAFE_PACKAGE.test(s));
}

export interface UserDataInput {
  config: VmConfig;
}

/** Build the base64-ready user-data string for a config. */
export function generateUserData({ config }: UserDataInput): string {
  return config.platform === "windows" ? windowsUserData(config) : linuxUserData(config);
}

// ---- Linux (cloud-init shell) ------------------------------------------------

function linuxUserData(config: UserDataInput["config"]): string {
  const pkgs = sanitizePackages(config.software);
  const lines: string[] = [
    "#!/bin/bash",
    "set -x",
    "# VM-Poppy first-boot provisioning",
    'exec > >(tee /var/log/vmpoppy-install.log) 2>&1',
  ];

  if (pkgs.length > 0) {
    // Install one package at a time and print a per-package verdict to the serial
    // console — a failed package (typo, repo lag) must surface on the card, not
    // hide in the install log while the batch "succeeds".
    lines.push(
      `pkg_report() { echo "${PKG_RESULT_PREFIX} $1 $2" | tee /dev/console || echo "${PKG_RESULT_PREFIX} $1 $2"; }`,
      "if command -v apt-get >/dev/null 2>&1; then",
      "  export DEBIAN_FRONTEND=noninteractive",
      "  apt-get update -y",
      '  pkg_install() { apt-get install -y "$1"; }',
      "elif command -v dnf >/dev/null 2>&1; then",
      '  pkg_install() { dnf install -y "$1"; }',
      "elif command -v yum >/dev/null 2>&1; then",
      '  pkg_install() { yum install -y "$1"; }',
      "else",
      '  pkg_install() { echo "no supported package manager"; false; }',
      "fi",
      `for p in ${pkgs.join(" ")}; do`,
      '  if pkg_install "$p"; then pkg_report OK "$p"; else pkg_report FAIL "$p"; fi',
      "done",
    );
  }

  if (config.setupScript?.trim()) {
    lines.push("# --- user setup script ---", config.setupScript.trim(), "# --- end setup script ---");
  }

  // Ephemeral TTL: schedule shutdown; combined with InstanceInitiatedShutdownBehavior=terminate
  // (set at RunInstances) this self-destructs the box even if the app is closed.
  if (config.lifecycle === "ephemeral" && config.autoTerminateHours && config.autoTerminateHours > 0) {
    const minutes = Math.max(1, Math.round(config.autoTerminateHours * 60));
    lines.push(`shutdown -h +${minutes} "VM-Poppy auto-terminate" || true`);
  }

  // Sentinel to the serial console (what GetConsoleOutput reads) AND the log.
  lines.push(`echo "${INSTALL_SENTINEL}" | tee /dev/console || echo "${INSTALL_SENTINEL}"`);
  return lines.join("\n") + "\n";
}

// ---- Windows (EC2Launch PowerShell) ------------------------------------------

function windowsUserData(config: UserDataInput["config"]): string {
  const pkgs = sanitizePackages(config.software);
  const body: string[] = [
    "<powershell>",
    "Start-Transcript -Path C:\\vmpoppy-install.log -Append",
    "$ErrorActionPreference = 'Continue'",
  ];

  if (pkgs.length > 0) {
    body.push(
      "# Install Chocolatey (reliable package manager on Windows Server)",
      "Set-ExecutionPolicy Bypass -Scope Process -Force",
      "[System.Net.ServicePointManager]::SecurityProtocol = 3072",
      "iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))",
      // Per-package verdicts, mirroring the Linux script. On Windows these lines land in
      // C:\vmpoppy-install.log for sure and in the EC2 console output best-effort — the
      // card shows them when available, and loses nothing when not.
      ...pkgs.flatMap((p) => [
        `choco install -y ${p}`,
        `if ($LASTEXITCODE -eq 0) { Write-Output "${PKG_RESULT_PREFIX} OK ${p}" } else { Write-Output "${PKG_RESULT_PREFIX} FAIL ${p}" }`,
      ]),
    );
  }

  if (config.setupScript?.trim()) {
    body.push("# --- user setup script ---", config.setupScript.trim(), "# --- end setup script ---");
  }

  if (config.lifecycle === "ephemeral" && config.autoTerminateHours && config.autoTerminateHours > 0) {
    const seconds = Math.max(60, Math.round(config.autoTerminateHours * 3600));
    body.push(`shutdown /s /t ${seconds} /c "VM-Poppy auto-terminate"`);
  }

  body.push(`Write-Output "${INSTALL_SENTINEL}"`, "Stop-Transcript", "</powershell>", "<persist>false</persist>");
  return body.join("\n") + "\n";
}

// ---- Console-output parsing (the read side of the verdict lines) --------------

/**
 * Parse the per-package `VMPOPPY_PKG OK|FAIL <name>` lines back out of the EC2
 * console output. The last verdict for a name wins (a retried install may print
 * FAIL then OK); names are matched with the same charset {@link sanitizePackages}
 * allows, so console noise can't fabricate entries.
 */
export function parsePackageOutcomes(consoleText: string): PackageOutcome[] {
  const verdicts = new Map<string, boolean>();
  const re = new RegExp(`${PKG_RESULT_PREFIX} (OK|FAIL) ([A-Za-z0-9][A-Za-z0-9._+-]*)`, "g");
  for (const m of consoleText.matchAll(re)) {
    verdicts.set(m[2]!, m[1] === "OK");
  }
  return [...verdicts].map(([name, ok]) => ({ name, ok }));
}
