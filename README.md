# VM-Poppy

**Spin up throwaway Linux or Windows VMs in your own AWS — from reusable configurations.** Define a
VM once (size, OS, software list), deploy it whenever you need it, let it install everything
automatically, connect, then **stop** or **tear it down**. An **[AgentsPoppy](https://agentspoppy.com)
extension** — it runs inside AgentsPoppy and uses the scoped, short-lived credentials the host vends
against *your own* AWS account.

> Runs **on** AgentsPoppy (it is not a fork of it). Your AWS stays yours; VM-Poppy only ever touches
> the EC2 resources it created, and you can tear the whole footprint down in one click.

## Why

- **Deploy and pay only when you need it.** A small instance is ~1.7¢/hour, billed per second, and
  "ephemeral" configs self-destruct on a TTL so nothing is ever left running by accident.
- **Reusable configs.** The template is the thing you keep; every deploy is a clean box.
- **Automatic install.** Your software list becomes cloud-init (Linux) / PowerShell (Windows).
- **Isolated by design.** The box gets **no AWS access inside it** — ideal for running code you
  don't fully trust.

## Security posture

- Rates **amber** in AgentsPoppy with **no beyond-own findings** — verified against the host's real
  risk assessor. Every change/delete is limited to VM-Poppy's own **tagged** instances, security
  groups, key pairs and volumes. **No IAM, no account/org access.**
- Full attribution + one-click teardown; see [`DESIGN.md`](./DESIGN.md).

## Develop

```bash
npm install
npm run build            # frontend (Vite) + backend sidecar (SEA)
npm run validate-manifest
npm run install-dev      # lay it into ~/.agentspoppy/extensions for local testing
# then relaunch AgentsPoppy and open the VM-Poppy tab
```

See [`DESIGN.md`](./DESIGN.md) for the architecture, the permission model, and the decisions of
record. Build guide for the framework: `~/Projects/agentspoppy/AGENTS.md`.

## License

Builds on AgentsPoppy under its FSL terms. Name follows the required `…Poppy` convention.
