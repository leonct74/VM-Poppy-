// VM-Poppy backend — shared types.
// Kept free of AWS-SDK imports so the pure logic (userdata, tags, mapping) is unit-testable.

/** A saved, reusable VM template. Persisted locally (never cloud state). */
export interface VmConfig {
  id: string;
  name: string;
  platform: "linux" | "windows";
  /** Logical OS key resolved to an AMI at launch (or overridden by amiId). */
  os: OsKey;
  arch: "arm64" | "x86_64";
  instanceType: string;
  /** Explicit AMI override (PRO). When set, os/arch are ignored for image resolution. */
  amiId?: string;
  diskGb: number;
  purchasing: "on-demand" | "spot";
  /** Package names installed automatically on first boot. */
  software: string[];
  /** Extra shell (Linux) / PowerShell (Windows) run after installs. */
  setupScript?: string;
  /** How the box is reached. */
  access: AccessMode;
  /** Custom ingress rules (PRO, when access === "custom"). */
  ingress?: IngressRule[];
  /** Drop outbound traffic (detonation). Breaks package installs — surfaced in UI. */
  restrictEgress?: boolean;
  /** TTL safety net in hours; undefined = no auto-terminate. */
  autoTerminateHours?: number;
  /** reusable = stop/start preserves the box; ephemeral = self-destructs on TTL/shutdown. */
  lifecycle: "reusable" | "ephemeral";
  /** Optional custom tags (on top of the three required attribution tags). */
  tags?: Record<string, string>;
  /** PRO: specific subnet (else default VPC's default subnet). */
  subnetId?: string;
}

export type OsKey =
  | "amazon-linux-2023"
  | "ubuntu-24.04"
  | "windows-2022";

export type AccessMode = "ssh-my-ip" | "rdp-my-ip" | "airgapped" | "custom";

export interface IngressRule {
  protocol: "tcp" | "udp";
  fromPort: number;
  toPort: number;
  /** CIDR, or the literal "my-ip" which the backend resolves to <caller-ip>/32. */
  cidr: string;
}

/** A live instance's state as reconstructed from EC2 (never from local storage). */
export interface VmSummary {
  instanceId: string;
  name: string;
  configId?: string;
  platform: "linux" | "windows";
  state: string; // pending | running | stopping | stopped | shutting-down | terminated
  instanceType: string;
  publicIp?: string;
  publicDns?: string;
  launchedAt?: string;
  lifecycle: "reusable" | "ephemeral";
  /** Derived install progress: booting | installing | ready | unknown. */
  install: InstallState;
  keyName?: string;
  /** The login user for SSH/RDP (ubuntu | ec2-user | Administrator). */
  user?: string;
}

/** The default login user for a given OS. */
export function loginUser(os: OsKey, platform: "linux" | "windows"): string {
  if (platform === "windows") return "Administrator";
  return os === "ubuntu-24.04" ? "ubuntu" : "ec2-user";
}

export type InstallState = "booting" | "installing" | "ready" | "unknown";

/** Everything the frontend sends to launch a VM (usually a saved VmConfig plus runtime bits). */
export interface LaunchRequest {
  config: VmConfig;
}

/** The sentinel the generated install script prints to the serial console when done. */
export const INSTALL_SENTINEL = "VMPOPPY_INSTALL_COMPLETE";
