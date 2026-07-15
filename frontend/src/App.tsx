import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { host, type AccessState } from "./host";
import { LaunchForm } from "./LaunchForm";
import { VmCard } from "./VmCard";
import { computeRunRate, formatUsd, type Meta, type VmConfig, type VmSummary } from "./types";

// Served from frontend/public → dist root; same file the manifest declares as the app icon.
const icon = "./vmpoppy-icon.png";

type Phase = "loading" | "gate" | "ready";

export function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [access, setAccess] = useState<AccessState>("pending");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [vms, setVms] = useState<VmSummary[]>([]);
  const [configs, setConfigs] = useState<VmConfig[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [editing, setEditing] = useState<VmConfig | undefined>(undefined);
  const pollRef = useRef<number | null>(null);

  /** Reconstruct live state from AWS (never from local memory) — framework §5. */
  const refresh = useCallback(async () => {
    try {
      const { vms: fresh } = await api.listVms();
      // For running boxes still installing, get the true install state.
      const withInstall = await Promise.all(
        fresh.map(async (vm) => {
          if (vm.state === "running" && vm.install !== "ready") {
            try { return { ...vm, install: (await api.installState(vm.instanceId)).state }; } catch { return vm; }
          }
          return vm;
        }),
      );
      setVms(withInstall);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const loadData = useCallback(async () => {
    const [{ configs: c }] = await Promise.all([api.listConfigs(), refresh()]);
    setConfigs(c);
  }, [refresh]);

  const connect = useCallback(async () => {
    setErr(null);
    try {
      const state = await host.ensureAccess();
      setAccess(state);
      if (state === "granted") { await loadData(); setPhase("ready"); }
      else setPhase("gate");
    } catch (e) {
      setErr((e as Error).message);
      setPhase("gate");
    }
  }, [loadData]);

  // Mount: read meta (no AWS), then request access.
  useEffect(() => {
    (async () => {
      try { setMeta(await api.meta()); } catch { /* meta is best-effort */ }
      await connect();
    })();
  }, [connect]);

  // Poll while granted.
  useEffect(() => {
    if (access !== "granted") return;
    pollRef.current = window.setInterval(refresh, 8000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [access, refresh]);

  async function launch(config: VmConfig) {
    setLaunching(true); setErr(null);
    try {
      await api.launch(config);
      setConfigs((await api.listConfigs()).configs);
      setEditing(undefined);
      await refresh();
      await host.notify({ title: "VM launching", body: `${config.name} is booting and installing software.` });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  // Stash a config WITHOUT launching it — so a template (e.g. a long software list) can be
  // reused later. The backend already exposes POST /configs.
  async function saveConfig(config: VmConfig) {
    setErr(null);
    try {
      setConfigs((await api.saveConfig(config)).configs);
      setEditing(undefined);
      await host.notify({ title: "Configuration saved", body: `“${config.name}” is in your saved configurations.` });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const header = (
    <div>
      <div className="app-header">
        <img src={icon} alt="" />
        <h1>VM-Poppy</h1>
      </div>
      <p className="app-sub">
        Throwaway Linux &amp; Windows VMs in your own AWS
        {meta ? <> · <span className="mono">{meta.account.accountId}</span> · {meta.account.region}</> : null}
      </p>
    </div>
  );

  if (phase === "loading") {
    return <div className="app">{header}<div className="card"><span className="spinner" /> Connecting…</div></div>;
  }

  if (phase === "gate" || access !== "granted") {
    return (
      <div className="app">
        {header}
        <div className="card">
          <h2 className="section-title">Connect your AWS</h2>
          <p className="muted-2">VM-Poppy needs your approval to use short-lived, scoped access to your AWS account. It can only ever touch the VMs it creates.</p>
          {access === "denied" && <div className="banner err" style={{ margin: "10px 0" }}>Access was declined. You can approve it to continue.</div>}
          {err && <div className="banner err" style={{ margin: "10px 0" }}>{err}</div>}
          <button className="btn btn-primary" onClick={connect}>Approve access</button>
        </div>
      </div>
    );
  }

  const running = vms.filter((v) => v.state !== "terminated");

  return (
    <div className="app">
      {header}
      {err && <div className="banner err" style={{ marginBottom: 14 }}>{err} <button className="btn btn-sm btn-ghost" onClick={connect}>Reconnect</button></div>}

      <LaunchForm busy={launching} onLaunch={launch} onSave={saveConfig} initial={editing} />

      {configs.length > 0 && (
        <div className="card">
          <h2 className="section-title">Saved configurations</h2>
          <div className="stack">
            {configs.map((c) => (
              <div key={c.id} className="spread">
                <div className="row" style={{ gap: 8 }}>
                  <strong>{c.name}</strong>
                  <span className="muted mono" style={{ fontSize: 12 }}>{c.os} · {c.instanceType}{c.software.length ? ` · ${c.software.length} pkg` : ""}</span>
                </div>
                <div className="row">
                  <button className="btn btn-sm" disabled={launching} onClick={() => launch(c)}>Deploy</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ ...c })}>Edit</button>
                  <button className="btn btn-sm btn-ghost" onClick={async () => setConfigs((await api.deleteConfig(c.id)).configs)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="spread" style={{ margin: "18px 2px 8px" }}>
        <h2 className="section-title" style={{ margin: 0 }}>Running VMs</h2>
        <button className="btn btn-sm btn-ghost" onClick={refresh}>Refresh</button>
      </div>

      {(() => {
        const r = computeRunRate(running);
        if (r.running === 0) {
          return (
            <div className="banner info" style={{ marginBottom: 12 }}>
              <span className="badge ok" style={{ marginRight: 8 }}><span className="dot" />$0/hr</span>
              Nothing running — you’re not being billed for compute{r.stopped > 0 ? `. ${r.stopped} stopped box${r.stopped > 1 ? "es" : ""} still cost a little for disk.` : "."}
            </div>
          );
        }
        return (
          <div className="banner" style={{ marginBottom: 12, borderColor: "var(--poppy-accent)" }}>
            <strong>Running now:</strong> {r.running} box{r.running > 1 ? "es" : ""} ≈ <strong>{formatUsd(r.hourly)}/hr</strong>
            {r.unknownRates > 0 ? ` (+${r.unknownRates} at a custom rate)` : ""}
            {r.stopped > 0 ? ` · ${r.stopped} stopped (disk only)` : ""}
            <span className="muted"> · approx, compute-only. Tear down to reach $0.</span>
          </div>
        );
      })()}

      {running.length === 0
        ? <div className="card"><span className="muted">No VMs yet. Configure one above and hit Deploy — it boots in under a minute and installs your software automatically.</span></div>
        : running.map((vm) => <VmCard key={vm.instanceId} vm={vm} onChanged={refresh} />)}
    </div>
  );
}
