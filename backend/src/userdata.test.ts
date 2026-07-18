import { describe, it, expect } from "vitest";
import { generateUserData, parsePackageOutcomes, sanitizePackages } from "./userdata";
import { attributionTags, ownInstancesFilter, tagValue, APP_ID, TAG_APP, TAG_CONNECTION, TAG_ACCOUNT } from "./tags";
import { INSTALL_SENTINEL, PKG_RESULT_PREFIX, type VmConfig } from "./types";

const base: VmConfig = {
  id: "cfg1",
  name: "Test box",
  platform: "linux",
  os: "ubuntu-24.04",
  arch: "arm64",
  instanceType: "t4g.small",
  diskGb: 20,
  purchasing: "on-demand",
  software: ["git", "docker.io", "python3"],
  access: "ssh-my-ip",
  lifecycle: "reusable",
};

describe("sanitizePackages", () => {
  it("keeps valid package tokens, drops injection attempts", () => {
    expect(sanitizePackages(["git", "docker.io", "g++"])).toEqual(["git", "docker.io", "g++"]);
    expect(sanitizePackages(["git; rm -rf /", "$(evil)", "a b", "  ", "ok-1"])).toEqual(["ok-1"]);
  });
});

describe("generateUserData — Linux", () => {
  const ud = generateUserData({ config: base });
  it("starts with a bash shebang and installs per-package via the right package managers", () => {
    expect(ud.startsWith("#!/bin/bash")).toBe(true);
    // One install invocation per package (attributable verdicts), per manager.
    expect(ud).toContain('pkg_install() { apt-get install -y "$1"; }');
    expect(ud).toContain('pkg_install() { dnf install -y "$1"; }');
    expect(ud).toContain('pkg_install() { yum install -y "$1"; }');
    expect(ud).toContain("for p in git docker.io python3; do");
    // Each package reports OK/FAIL to the serial console.
    expect(ud).toContain('if pkg_install "$p"; then pkg_report OK "$p"; else pkg_report FAIL "$p"; fi');
    expect(ud).toContain(`${PKG_RESULT_PREFIX} $1 $2`);
  });
  it("prints the sentinel to the console", () => {
    expect(ud).toContain(INSTALL_SENTINEL);
    expect(ud).toContain("/dev/console");
  });
  it("includes a setup script when provided", () => {
    const ud2 = generateUserData({ config: { ...base, setupScript: "echo hello-setup" } });
    expect(ud2).toContain("echo hello-setup");
  });
  it("schedules self-shutdown only for ephemeral configs with a TTL", () => {
    expect(ud).not.toContain("shutdown -h");
    const eph = generateUserData({ config: { ...base, lifecycle: "ephemeral", autoTerminateHours: 2 } });
    expect(eph).toContain("shutdown -h +120");
  });
});

describe("generateUserData — Windows", () => {
  const ud = generateUserData({
    config: { ...base, platform: "windows", os: "windows-2022", arch: "x86_64", software: ["googlechrome", "git"] },
  });
  it("wraps PowerShell and installs via Chocolatey", () => {
    expect(ud).toContain("<powershell>");
    expect(ud).toContain("</powershell>");
    expect(ud).toContain("choco install -y googlechrome");
    expect(ud).toContain("choco install -y git");
    expect(ud).toContain(INSTALL_SENTINEL);
  });
  it("reports a per-package verdict after each choco install", () => {
    expect(ud).toContain(`if ($LASTEXITCODE -eq 0) { Write-Output "${PKG_RESULT_PREFIX} OK googlechrome" } else { Write-Output "${PKG_RESULT_PREFIX} FAIL googlechrome" }`);
    expect(ud).toContain(`${PKG_RESULT_PREFIX} OK git`);
  });
  it("uses seconds for the Windows shutdown timer when ephemeral", () => {
    const eph = generateUserData({
      config: { ...base, platform: "windows", os: "windows-2022", lifecycle: "ephemeral", autoTerminateHours: 1 },
    });
    expect(eph).toContain("shutdown /s /t 3600");
  });
});

describe("attribution tags", () => {
  const ctx = { accountId: "111122223333", connectionId: "conn-abc" };
  it("stamps all three required keys", () => {
    const tags = attributionTags(ctx);
    expect(tagValue(tags, TAG_ACCOUNT)).toBe("111122223333");
    expect(tagValue(tags, TAG_APP)).toBe(APP_ID);
    expect(tagValue(tags, TAG_CONNECTION)).toBe("conn-abc");
  });
  it("filters to this APP's instances (app-scoped, NOT connection-scoped — survives supersede)", () => {
    const f = ownInstancesFilter(ctx);
    expect(f).toEqual([{ Name: `tag:${TAG_APP}`, Values: [APP_ID] }]);
    // Must NOT scope by connection id — that would strand VMs from a superseded connection.
    expect(f.some((x) => x.Name === `tag:${TAG_CONNECTION}`)).toBe(false);
  });
});

describe("parsePackageOutcomes", () => {
  it("parses OK and FAIL lines out of console noise", () => {
    const text = [
      "cloud-init[512]: some boot noise",
      "VMPOPPY_PKG OK git",
      "more noise … VMPOPPY_PKG FAIL googlechrome",
      "VMPOPPY_INSTALL_COMPLETE",
    ].join("\n");
    expect(parsePackageOutcomes(text)).toEqual([
      { name: "git", ok: true },
      { name: "googlechrome", ok: false },
    ]);
  });
  it("last verdict for a package wins (a retried install may FAIL then OK)", () => {
    const text = "VMPOPPY_PKG FAIL docker.io\nVMPOPPY_PKG OK docker.io";
    expect(parsePackageOutcomes(text)).toEqual([{ name: "docker.io", ok: true }]);
  });
  it("returns nothing for consoles without verdict lines (old boxes, Windows without forwarding)", () => {
    expect(parsePackageOutcomes("plain boot output\nVMPOPPY_INSTALL_COMPLETE")).toEqual([]);
  });
});
