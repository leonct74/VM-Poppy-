// Detect the user's current public IPv4 so the default security group can open
// SSH/RDP to their machine only (not 0.0.0.0/0). Best-effort: if it can't be
// resolved we fail closed (caller decides) rather than silently opening to the world.

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

export async function detectPublicIp(): Promise<string | null> {
  try {
    const res = await fetch("https://checkip.amazonaws.com", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const ip = (await res.text()).trim();
    return IPV4.test(ip) ? ip : null;
  } catch {
    return null;
  }
}
