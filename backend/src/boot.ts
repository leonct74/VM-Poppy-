// Bootstrap + credential minting for the container model.
//
// The host spawns this backend and injects AGENTSPOPPY_BOOTSTRAP (JSON). We mint
// short-lived, tag-scoped credentials on demand by POSTing credentialsUrl with the
// per-backend bearer token, and hand them to the AWS SDK as an auto-refreshing
// credential provider. We NEVER see the operator's own keys. See AGENTS.md §7.

export interface BackendBootstrap {
  connectionId: string;
  credentialsUrl: string;
  credentialsToken?: string;
  port?: number;
  account: { accountId: string; region: string };
}

/** AWS SDK v3 AwsCredentialIdentity (structural — avoids importing the SDK here). */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}
export type AwsCredentialIdentityProvider = () => Promise<AwsCredentialIdentity>;

const REFRESH_BUFFER_MS = 300_000; // re-mint 5 min before expiry

export function readBootstrap(): BackendBootstrap {
  const raw = process.env.AGENTSPOPPY_BOOTSTRAP;
  if (!raw) throw new Error("AGENTSPOPPY_BOOTSTRAP is not set — this backend must be spawned by AgentsPoppy.");
  let boot: BackendBootstrap;
  try {
    boot = JSON.parse(raw);
  } catch (e) {
    throw new Error(`AGENTSPOPPY_BOOTSTRAP is not valid JSON: ${(e as Error).message}`);
  }
  if (!boot.connectionId || !boot.credentialsUrl || !boot.account?.accountId) {
    throw new Error("AGENTSPOPPY_BOOTSTRAP is missing required fields (connectionId/credentialsUrl/account).");
  }
  return boot;
}

interface ScopedCredentialsDTO {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

/**
 * An auto-refreshing credential provider backed by the broker's mint endpoint.
 * Caches the last mint until ~5 min before expiry, then re-mints. Surfaces a clear
 * error when the broker refuses (paused/revoked/AWS-access lapsed) — never falls
 * back to broader creds (framework decision D1).
 */
export function brokerCredentialsProvider(boot: BackendBootstrap): AwsCredentialIdentityProvider {
  let cached: AwsCredentialIdentity | null = null;

  return async () => {
    if (cached?.expiration && cached.expiration.getTime() - Date.now() > REFRESH_BUFFER_MS) {
      return cached;
    }
    const res = await fetch(boot.credentialsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(boot.credentialsToken ? { authorization: `Bearer ${boot.credentialsToken}` } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `AgentsPoppy won't grant AWS access right now (${res.status}). ` +
          `Check that VM-Poppy is connected and your AWS access is healthy in AgentsPoppy.` +
          (text ? ` [${text.slice(0, 200)}]` : ""),
      );
    }
    const dto = (await res.json()) as ScopedCredentialsDTO;
    cached = {
      accessKeyId: dto.accessKeyId,
      secretAccessKey: dto.secretAccessKey,
      sessionToken: dto.sessionToken,
      expiration: dto.expiration ? new Date(dto.expiration) : undefined,
    };
    return cached;
  };
}
