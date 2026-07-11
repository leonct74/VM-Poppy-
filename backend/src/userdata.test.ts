import { describe, it, expect } from "vitest";
import { generateUserData, sanitizePackages } from "./userdata";
import { attributionTags, ownInstancesFilter, tagValue, APP_ID, TAG_APP, TAG_CONNECTION, TAG_ACCOUNT } from "./tags";
import { INSTALL_SENTINEL, type VmConfig } from "./types";

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
  it("starts with a bash shebang and installs via the right package managers", () => {
    expect(ud.startsWith("#!/bin/bash")).toBe(true);
    expect(ud).toContain("apt-get install -y git docker.io python3");
    expect(ud).toContain("dnf install -y git docker.io python3");
    expect(ud).toContain("yum install -y git docker.io python3");
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
  it("filters to this connection's own instances", () => {
    const f = ownInstancesFilter(ctx);
    expect(f).toContainEqual({ Name: `tag:${TAG_APP}`, Values: [APP_ID] });
    expect(f).toContainEqual({ Name: `tag:${TAG_CONNECTION}`, Values: ["conn-abc"] });
  });
});
