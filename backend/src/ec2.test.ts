import { describe, it, expect } from "vitest";
import { detectPlatform } from "./ec2";
import { TAG_PLATFORM } from "./tags";

describe("detectPlatform", () => {
  it("trusts our own vmpoppy:platform tag when present (bulletproof)", () => {
    expect(detectPlatform({ Tags: [{ Key: TAG_PLATFORM, Value: "windows" }] })).toBe("windows");
    expect(detectPlatform({ Tags: [{ Key: TAG_PLATFORM, Value: "linux" }], Platform: "windows" })).toBe("linux");
  });

  it("detects Windows from the lowercase wire value (the bug: SDK types it 'Windows')", () => {
    // AWS returns lowercase "windows" on the wire even though the SDK enum says "Windows".
    expect(detectPlatform({ Platform: "windows" })).toBe("windows");
    expect(detectPlatform({ Platform: "Windows" })).toBe("windows"); // and the cased form too
  });

  it("falls back to PlatformDetails when Platform is absent", () => {
    expect(detectPlatform({ PlatformDetails: "Windows" })).toBe("windows");
    expect(detectPlatform({ PlatformDetails: "Windows BYOL" })).toBe("windows");
    expect(detectPlatform({ PlatformDetails: "Linux/UNIX" })).toBe("linux");
  });

  it("defaults to linux when nothing indicates Windows", () => {
    expect(detectPlatform({})).toBe("linux");
    expect(detectPlatform({ Platform: undefined, PlatformDetails: "Red Hat Enterprise Linux" })).toBe("linux");
  });
});
