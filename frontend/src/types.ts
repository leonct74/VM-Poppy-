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
// Rough USD on-demand hourly rates (Linux, eu-west-1-ish). Approx · vary by region/OS
// (Windows adds a license charge, so it costs MORE than these). Single source for the size
// hints AND the live run-rate. Hardcoded for now; DESIGN.md §14 tracks the live Price List API.
export const HOURLY_USD: Record<string, number> = {
  "t4g.small": 0.017,
  "t4g.medium": 0.034,
  "t4g.large": 0.067,
  "t3.small": 0.021,
  "t3.medium": 0.042,
  "t3.large": 0.083,
};

export const SIZE_CATALOG: { type: string; arch: "arm64" | "x86_64"; label: string; hint: string }[] = [
  { type: "t4g.small", arch: "arm64", label: "t4g.small", hint: "2 vCPU · 2 GB · ~$0.017/hr" },
  { type: "t4g.medium", arch: "arm64", label: "t4g.medium", hint: "2 vCPU · 4 GB · ~$0.034/hr" },
  { type: "t4g.large", arch: "arm64", label: "t4g.large", hint: "2 vCPU · 8 GB · ~$0.067/hr" },
  { type: "t3.small", arch: "x86_64", label: "t3.small", hint: "2 vCPU · 2 GB · ~$0.021/hr" },
  { type: "t3.medium", arch: "x86_64", label: "t3.medium", hint: "2 vCPU · 4 GB · ~$0.042/hr" },
  { type: "t3.large", arch: "x86_64", label: "t3.large", hint: "2 vCPU · 8 GB · ~$0.083/hr" },
];

export interface RunRate {
  running: number;
  /** Summed hourly USD for running boxes whose type we have a rate for. */
  hourly: number;
  /** Running boxes at a type not in HOURLY_USD (e.g. a PRO custom instance type). */
  unknownRates: number;
  /** Stopped boxes — no compute charge, but a small disk cost. */
  stopped: number;
}

/** Live "am I billing right now?" from the app's own inventory. Compute-only estimate. */
export function computeRunRate(vms: VmSummary[]): RunRate {
  const r: RunRate = { running: 0, hourly: 0, unknownRates: 0, stopped: 0 };
  for (const vm of vms) {
    if (vm.state === "running" || vm.state === "pending") {
      r.running++;
      const rate = HOURLY_USD[vm.instanceType];
      if (rate === undefined) r.unknownRates++;
      else r.hourly += rate;
    } else if (vm.state === "stopped") {
      r.stopped++;
    }
  }
  return r;
}

export function formatUsd(n: number): string {
  return n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}
