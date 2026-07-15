import { useEffect, useState } from "react";
import { api } from "./api";
import { CopyButton } from "./CopyButton";
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
  if (vm.state === "shutting-down") return <span className="badge warn"><span className="spinner" />terminating…</span>;
  if (vm.state === "stopped") return <span className="badge"><span className="dot" />stopped</span>;
  return <span className="badge"><span className="dot" />{vm.state}</span>;
}

export function VmCard({ vm, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [pwdWaiting, setPwdWaiting] = useState(false);

  async function revealPassword() {
    setBusy("pwd"); setErr(null);
    try {
      const r = await api.windowsPassword(vm.instanceId);
      if (r.ready && r.password) { setSecret(r.password); setPwdWaiting(false); }
      else setPwdWaiting(true); // normal early state — the effect below keeps checking
    } catch (e) { setErr((e as Error).message); setPwdWaiting(false); }
    finally { setBusy(null); }
  }

  // While waiting, re-ask every 15s until Windows has generated the password.
  useEffect(() => {
    if (!pwdWaiting || secret) return;
    const t = window.setInterval(async () => {
      try {
        const r = await api.windowsPassword(vm.instanceId);
        if (r.ready && r.password) { setSecret(r.password); setPwdWaiting(false); }
      } catch { /* transient — keep polling */ }
    }, 15000);
    return () => window.clearInterval(t);
  }, [pwdWaiting, secret, vm.instanceId]);

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
  // Minutes since launch — used to soften the "installing" copy once it's clearly just the
  // GetConsoleOutput lag rather than a real install still running.
  const minutesUp = vm.launchedAt ? (Date.now() - new Date(vm.launchedAt).getTime()) / 60000 : 0;

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
        AWS id {vm.instanceId}
        {ip ? <> · address <strong>{ip}</strong></> : null}
        {vm.launchedAt ? ` · launched ${new Date(vm.launchedAt).toLocaleString()}` : ""}
      </div>

      {/* Connect */}
      {vm.state === "running" && (
        <div className="card card-2" style={{ marginTop: 10, marginBottom: 10 }}>
          <div className="section-title">Connect</div>
          {vm.platform === "windows" ? (
            <div className="stack">
              <div className="muted-2 row" style={{ flexWrap: "wrap", gap: 4 }}>
                <span>In your RDP client (e.g. Windows App), the <strong>“PC name”</strong> is this address:</span>
                <span className="chip" style={{ userSelect: "all" }}>{ip ?? "…"}</span>
                {ip && <CopyButton text={ip} label="address" />}
                <span>— sign in as <span className="chip">Administrator</span></span>
              </div>
              <div className="row">
                <button className="btn btn-sm" disabled={busy === "pwd" || pwdWaiting} onClick={revealPassword}>
                  {busy === "pwd" ? "Decrypting…" : pwdWaiting ? <><span className="spinner" /> Waiting for Windows…</> : "Reveal password"}
                </button>
                {secret && (
                  <>
                    <span className="chip" style={{ userSelect: "all" }}>{secret}</span>
                    <CopyButton text={secret} label="password" />
                  </>
                )}
              </div>
              {pwdWaiting && !secret && (
                <div className="muted" style={{ fontSize: 12 }}>
                  Windows generates the Administrator password during its first minutes after launch — nothing is wrong.
                  I’ll keep checking and show it here the moment it’s ready.
                </div>
              )}
              <div className="muted" style={{ fontSize: 12 }}>
                To leave the session, just <strong>close the RDP window</strong> (in full screen: mouse to the top edge,
                or Ctrl+⌘+F) — the box keeps running. Windows’ own “Shut down”{" "}
                {vm.lifecycle === "ephemeral"
                  ? "permanently self-destructs a throwaway box."
                  : "powers the box off — restart it here with Start."}
              </div>
            </div>
          ) : (
            <div className="stack">
              {sshCmd
                ? <div className="chip" style={{ display: "block", userSelect: "all", wordBreak: "break-all" }}>{sshCmd}</div>
                : <div className="muted">Waiting for a public IP…</div>}
              <div className="row">
                <button className="btn btn-sm" onClick={downloadKey} disabled={!vm.keyName}>Download SSH key</button>
                {sshCmd && <CopyButton text={sshCmd} label="SSH command" />}
              </div>
            </div>
          )}
          {vm.install === "installing" && (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              {minutesUp > 6
                ? "The install may already be finished — the ready signal can lag a few minutes. You can connect now and check (Linux: run cloud-init status)."
                : "First launch installs your software — this can take a few minutes. You can connect as soon as the box is running (above); it keeps going in the background."}
            </div>
          )}
        </div>
      )}

      {err && <div className="banner err" style={{ marginBottom: 10 }}>{err}</div>}

      {vm.state === "stopped" && (
        <div className="muted" style={{ fontSize: 12, margin: "4px 0 8px" }}>
          Stopped — it only costs its small disk fee. <strong>Start</strong> powers it back on with a{" "}
          <strong>new address</strong>; the password is unchanged.
        </div>
      )}

      {/* Lifecycle actions */}
      <div className="row">
        {vm.state === "running" && vm.lifecycle === "reusable" && (
          <button className="btn btn-sm" disabled={!!busy} onClick={() => act("stop", () => api.stop(vm.instanceId))}>{busy === "stop" ? "Stopping…" : "Stop"}</button>
        )}
        {vm.state === "stopped" && (
          <button className="btn btn-sm" disabled={!!busy} onClick={() => act("start", () => api.start(vm.instanceId))}
            title="Powers the box back on. It gets a NEW address — reconnect using the address shown after it starts.">
            {busy === "start" ? "Starting…" : "Start"}
          </button>
        )}
        <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => setConfirmKill(true)}>
          {busy === "kill" ? <><span className="spinner" /> Tearing down…</> : "Tear down"}
        </button>
        {ip && <button className="btn btn-sm btn-ghost" onClick={() => host.openExternal(`https://console.aws.amazon.com/ec2/home#InstanceDetails:instanceId=${vm.instanceId}`)}>Open in AWS console</button>}
      </div>

      {confirmKill && (
        <div className="scrim" onClick={() => setConfirmKill(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Tear down “{vm.name}”?</h3>
            <p className="muted-2">This permanently <strong>terminates</strong> instance <span className="chip">{vm.instanceId}</span> (“terminate” is AWS’s word for delete) and removes its disk, security group and key pair. It <strong>cannot be undone</strong> and anything on the box is lost.</p>
            <p className="muted-2" style={{ marginTop: -4 }}>It <strong>stops billing immediately</strong>. In your AWS console it will show as <span className="chip">Terminated</span> for up to an hour, then disappear — that’s the fully-deleted state, not “stopped”.</p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn" autoFocus onClick={() => setConfirmKill(false)}>Cancel</button>
              <button className="btn btn-danger" disabled={!!busy} onClick={() => act("kill", async () => {
                await api.terminate(vm.instanceId);
                setConfirmKill(false);
                await host.notify({ title: "VM terminated", body: `“${vm.name}” is being deleted (AWS: “Terminated”) — no longer billing.` });
              })}>
                {busy === "kill" ? <><span className="spinner" /> Tearing down…</> : "Tear down"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
