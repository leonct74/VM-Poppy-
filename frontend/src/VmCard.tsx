import { useState } from "react";
import { api } from "./api";
import { host } from "./host";
import type { VmSummary } from "./types";

interface Props {
  vm: VmSummary;
  onChanged: () => void;
}

function stateBadge(vm: VmSummary) {
  if (vm.state === "running") {
    if (vm.install === "installing") return <span className="badge warn"><span className="spinner" />installing…</span>;
    if (vm.install === "ready") return <span className="badge ok"><span className="dot" />ready</span>;
    return <span className="badge run"><span className="dot" />running</span>;
  }
  if (vm.state === "pending") return <span className="badge warn"><span className="spinner" />booting…</span>;
  if (vm.state === "stopped") return <span className="badge"><span className="dot" />stopped</span>;
  return <span className="badge"><span className="dot" />{vm.state}</span>;
}

export function VmCard({ vm, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label); setErr(null);
    try { await fn(); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  async function downloadKey() {
    if (!vm.keyName) return;
    try {
      const { pem, keyName } = await api.privateKey(vm.instanceId, vm.keyName);
      const blob = new Blob([pem], { type: "application/x-pem-file" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${keyName}.pem`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setErr((e as Error).message); }
  }

  const ip = vm.publicIp;
  const sshUser = vm.user ?? "ec2-user";
  const sshCmd = ip && vm.keyName ? `ssh -i ~/.vmpoppy/keys/${vm.keyName}.pem ${sshUser}@${ip}` : null;

  return (
    <div className="card">
      <div className="spread">
        <div className="row" style={{ gap: 8 }}>
          <strong>{vm.name}</strong>
          {stateBadge(vm)}
          {vm.lifecycle === "ephemeral" && <span className="badge warn"><span className="dot" />self-destructs</span>}
        </div>
        <span className="mono muted" style={{ fontSize: 12 }}>{vm.instanceType}</span>
      </div>

      <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
        {vm.instanceId}{ip ? ` · ${ip}` : ""}{vm.launchedAt ? ` · ${new Date(vm.launchedAt).toLocaleString()}` : ""}
      </div>

      {/* Connect */}
      {vm.state === "running" && (
        <div className="card card-2" style={{ marginTop: 10, marginBottom: 10 }}>
          <div className="section-title">Connect</div>
          {vm.platform === "windows" ? (
            <div className="stack">
              <div className="muted-2">RDP to <span className="chip">{ip ?? "…"}</span> as <span className="chip">Administrator</span></div>
              <div className="row">
                <button className="btn btn-sm" disabled={busy === "pwd"} onClick={() => act("pwd", async () => setSecret((await api.windowsPassword(vm.instanceId)).password))}>
                  {busy === "pwd" ? "Decrypting…" : "Reveal password"}
                </button>
                {secret && <span className="chip" style={{ userSelect: "all" }}>{secret}</span>}
              </div>
            </div>
          ) : (
            <div className="stack">
              {sshCmd
                ? <div className="chip" style={{ display: "block", userSelect: "all", wordBreak: "break-all" }}>{sshCmd}</div>
                : <div className="muted">Waiting for a public IP…</div>}
              <div className="row">
                <button className="btn btn-sm" onClick={downloadKey} disabled={!vm.keyName}>Download SSH key</button>
                {sshCmd && <button className="btn btn-sm btn-ghost" onClick={() => navigator.clipboard?.writeText(sshCmd)}>Copy command</button>}
              </div>
            </div>
          )}
          {vm.install === "installing" && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Software is still installing on the box — it keeps going in the background.</div>}
        </div>
      )}

      {err && <div className="banner err" style={{ marginBottom: 10 }}>{err}</div>}

      {/* Lifecycle actions */}
      <div className="row">
        {vm.state === "running" && vm.lifecycle === "reusable" && (
          <button className="btn btn-sm" disabled={!!busy} onClick={() => act("stop", () => api.stop(vm.instanceId))}>{busy === "stop" ? "Stopping…" : "Stop"}</button>
        )}
        {vm.state === "stopped" && (
          <button className="btn btn-sm" disabled={!!busy} onClick={() => act("start", () => api.start(vm.instanceId))}>{busy === "start" ? "Starting…" : "Start"}</button>
        )}
        <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => setConfirmKill(true)}>Tear down</button>
        {ip && <button className="btn btn-sm btn-ghost" onClick={() => host.openExternal(`https://console.aws.amazon.com/ec2/home#InstanceDetails:instanceId=${vm.instanceId}`)}>Open in AWS console</button>}
      </div>

      {confirmKill && (
        <div className="scrim" onClick={() => setConfirmKill(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Tear down “{vm.name}”?</h3>
            <p className="muted-2">This permanently terminates instance <span className="chip">{vm.instanceId}</span>, deletes its disk, security group and key pair, and <strong>cannot be undone</strong>. Anything on the box is lost.</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn" autoFocus onClick={() => setConfirmKill(false)}>Cancel</button>
              <button className="btn btn-danger" disabled={!!busy} onClick={() => { setConfirmKill(false); act("kill", () => api.terminate(vm.instanceId)); }}>
                {busy === "kill" ? "Tearing down…" : "Tear down"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
