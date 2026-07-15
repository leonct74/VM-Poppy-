import { useMemo, useState } from "react";
import { OS_CATALOG, SIZE_CATALOG, type OsKey, type VmConfig } from "./types";

interface Props {
  busy: boolean;
  onLaunch: (config: VmConfig) => void;
  initial?: VmConfig;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `cfg-${Date.now()}`;
}

function defaults(): VmConfig {
  return {
    id: newId(),
    name: "",
    platform: "linux",
    os: "ubuntu-24.04",
    arch: "arm64",
    instanceType: "t4g.small",
    diskGb: 20,
    purchasing: "on-demand",
    software: [],
    access: "ssh-my-ip",
    lifecycle: "reusable",
    autoTerminateHours: 8,
  };
}

export function LaunchForm({ busy, onLaunch, initial }: Props) {
  const [cfg, setCfg] = useState<VmConfig>(initial ?? defaults());
  const [pro, setPro] = useState(false);
  const [softwareText, setSoftwareText] = useState((initial?.software ?? []).join(", "));

  const set = <K extends keyof VmConfig>(k: K, v: VmConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));

  const osInfo = OS_CATALOG.find((o) => o.key === cfg.os) ?? OS_CATALOG[0]!;
  const sizes = useMemo(() => SIZE_CATALOG.filter((s) => osInfo.arches.includes(s.arch)), [osInfo]);

  // When OS changes, keep platform/arch/size/access coherent.
  function pickOs(os: OsKey) {
    const info = OS_CATALOG.find((o) => o.key === os)!;
    const size = SIZE_CATALOG.find((s) => info.arches.includes(s.arch))!;
    setCfg((c) => ({
      ...c,
      os,
      platform: info.platform,
      arch: size.arch,
      instanceType: size.type,
      access: info.platform === "windows" ? "rdp-my-ip" : c.access === "rdp-my-ip" ? "ssh-my-ip" : c.access,
      diskGb: info.platform === "windows" ? Math.max(c.diskGb, 30) : c.diskGb,
    }));
  }

  function pickSize(type: string) {
    const size = SIZE_CATALOG.find((s) => s.type === type)!;
    setCfg((c) => ({ ...c, instanceType: type, arch: size.arch }));
  }

  function submit() {
    const software = softwareText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const name = cfg.name.trim() || `${osInfo.label} box`;
    onLaunch({ ...cfg, name, software });
  }

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 className="section-title" style={{ margin: 0 }}>New VM</h2>
        <div className="tabs">
          <button className={`tab ${!pro ? "active" : ""}`} onClick={() => setPro(false)}>Quick</button>
          <button className={`tab ${pro ? "active" : ""}`} onClick={() => setPro(true)}>PRO</button>
        </div>
      </div>

      <label className="field">
        <span>Name</span>
        <input className="input" placeholder={`${osInfo.label} box`} value={cfg.name}
          onChange={(e) => set("name", e.target.value)} />
      </label>

      <div className="grid-2">
        <label className="field">
          <span>Operating system</span>
          <select className="select" value={cfg.os} onChange={(e) => pickOs(e.target.value as OsKey)}>
            {OS_CATALOG.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Size <span className="muted" style={{ fontWeight: 400 }}>· prices approx, vary by region/OS</span></span>
          <select className="select" value={cfg.instanceType} onChange={(e) => pickSize(e.target.value)}>
            {sizes.map((s) => <option key={s.type} value={s.type}>{s.label} — {s.hint}</option>)}
          </select>
        </label>
      </div>

      <label className="field">
        <span>Software to install automatically (space or comma separated)</span>
        <input className="input mono" placeholder={cfg.platform === "windows" ? "git googlechrome vscode" : "git docker.io python3"}
          value={softwareText} onChange={(e) => setSoftwareText(e.target.value)} />
      </label>

      <div className="grid-2">
        <label className="field">
          <span>When you're done</span>
          <select className="select" value={cfg.lifecycle} onChange={(e) => set("lifecycle", e.target.value as VmConfig["lifecycle"])}>
            <option value="reusable">Keep it — I'll stop/start it</option>
            <option value="ephemeral">Throwaway — self-destruct on a timer</option>
          </select>
        </label>
        {cfg.lifecycle === "ephemeral" && (
          <label className="field">
            <span>Self-destruct after (hours)</span>
            <input className="input" type="number" min={1} value={cfg.autoTerminateHours ?? ""}
              onChange={(e) => { const n = parseInt(e.target.value, 10); set("autoTerminateHours", Number.isFinite(n) && n > 0 ? n : undefined); }} />
          </label>
        )}
      </div>
      {cfg.lifecycle === "reusable" && (
        <p className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 12 }}>
          A kept box bills until you <strong>Stop</strong> it (small disk cost only) or <strong>Tear it down</strong> ($0). It won't self-destruct.
        </p>
      )}

      {pro && (
        <div className="card card-2" style={{ marginTop: 4 }}>
          <h3 className="section-title">Advanced</h3>
          <div className="grid-2">
            <label className="field">
              <span>Purchasing</span>
              <select className="select" value={cfg.purchasing} onChange={(e) => set("purchasing", e.target.value as VmConfig["purchasing"])}>
                <option value="on-demand">On-Demand</option>
                <option value="spot">Spot (~70% cheaper, can be reclaimed)</option>
              </select>
            </label>
            <label className="field">
              <span>Root disk (GB)</span>
              <input className="input" type="number" min={8} value={cfg.diskGb} onChange={(e) => set("diskGb", Number(e.target.value) || 20)} />
            </label>
          </div>
          <label className="field">
            <span>Specific AMI id (optional — overrides the OS image)</span>
            <input className="input mono" placeholder="ami-0123456789abcdef0" value={cfg.amiId ?? ""} onChange={(e) => set("amiId", e.target.value || undefined)} />
          </label>
          <label className="field">
            <span>Network access</span>
            <select className="select" value={cfg.access} onChange={(e) => set("access", e.target.value as VmConfig["access"])}>
              {cfg.platform === "windows"
                ? <option value="rdp-my-ip">RDP (3389) from my IP only</option>
                : <option value="ssh-my-ip">SSH (22) from my IP only</option>}
              <option value="airgapped">Airgapped — no inbound access</option>
            </select>
          </label>
          <label className="field">
            <span>Extra setup script (runs after installs)</span>
            <textarea className="input" placeholder={cfg.platform === "windows" ? "# PowerShell" : "# bash"} value={cfg.setupScript ?? ""} onChange={(e) => set("setupScript", e.target.value || undefined)} />
          </label>
          <label className="row" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={!!cfg.restrictEgress} onChange={(e) => set("restrictEgress", e.target.checked)} />
            <span className="muted-2">Block outbound traffic (detonation mode — note: this also blocks package installs)</span>
          </label>
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          {busy ? "Launching…" : "Deploy VM"}
        </button>
        {cfg.lifecycle === "ephemeral" && <span className="badge warn"><span className="dot" />self-destructs</span>}
        {cfg.purchasing === "spot" && <span className="badge">spot</span>}
      </div>
    </div>
  );
}
