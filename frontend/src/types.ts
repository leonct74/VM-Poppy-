// Frontend mirror of the backend's shared types (kept in sync by hand — small surface).

export type OsKey = "amazon-linux-2023" | "ubuntu-24.04" | "windows-2022";
export type AccessMode = "ssh-my-ip" | "rdp-my-ip" | "airgapped" | "custom";
export type Lifecycle = "reusable" | "ephemeral";
export type InstallState = "booting" | "installing" | "ready" | "unknown";

export interface IngressRule {
  protocol: "tcp" | "udp";
  fromPort: number;
  toPort: number;
  cidr: string;
}

export interface VmConfig {
  id: string;
  name: string;
  platform: "linux" | "windows";
  os: OsKey;
  arch: "arm64" | "x86_64";
  instanceType: string;
  amiId?: string;
  diskGb: number;
  purchasing: "on-demand" | "spot";
  software: string[];
  setupScript?: string;
  access: AccessMode;
  ingress?: IngressRule[];
  restrictEgress?: boolean;
  autoTerminateHours?: number;
  lifecycle: Lifecycle;
  tags?: Record<string, string>;
  subnetId?: string;
}

export interface VmSummary {
  instanceId: string;
  name: string;
  configId?: string;
  platform: "linux" | "windows";
  state: string;
  instanceType: string;
  publicIp?: string;
  publicDns?: string;
  launchedAt?: string;
  lifecycle: Lifecycle;
  install: InstallState;
  keyName?: string;
  user?: string;
}

export interface Meta {
  account: { accountId: string; region: string };
  connectionId: string;
}

/** OS catalog for the UI. */
export const OS_CATALOG: { key: OsKey; label: string; platform: "linux" | "windows"; arches: ("arm64" | "x86_64")[] }[] = [
  { key: "ubuntu-24.04", label: "Ubuntu 24.04 LTS", platform: "linux", arches: ["arm64", "x86_64"] },
  { key: "amazon-linux-2023", label: "Amazon Linux 2023", platform: "linux", arches: ["arm64", "x86_64"] },
  { key: "windows-2022", label: "Windows Server 2022", platform: "windows", arches: ["x86_64"] },
];

/** A few sensible instance sizes with rough hourly cost, by architecture. */
// Prices are ROUGH USD on-demand estimates (approx · vary by region/OS; Windows adds a
// license charge). Hardcoded for now; DESIGN.md §14 tracks moving these to the live
// Price List API. Update here if AWS pricing shifts.
export const SIZE_CATALOG: { type: string; arch: "arm64" | "x86_64"; label: string; hint: string }[] = [
  { type: "t4g.small", arch: "arm64", label: "t4g.small", hint: "2 vCPU · 2 GB · ~$0.017/hr" },
  { type: "t4g.medium", arch: "arm64", label: "t4g.medium", hint: "2 vCPU · 4 GB · ~$0.034/hr" },
  { type: "t4g.large", arch: "arm64", label: "t4g.large", hint: "2 vCPU · 8 GB · ~$0.067/hr" },
  { type: "t3.small", arch: "x86_64", label: "t3.small", hint: "2 vCPU · 2 GB · ~$0.021/hr" },
  { type: "t3.medium", arch: "x86_64", label: "t3.medium", hint: "2 vCPU · 4 GB · ~$0.042/hr" },
  { type: "t3.large", arch: "x86_64", label: "t3.large", hint: "2 vCPU · 8 GB · ~$0.083/hr" },
];
