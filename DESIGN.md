# DESIGN.md — VM-Poppy

Source of truth for VM-Poppy. An **AgentsPoppy extension** ("poppy") that lets a user spin up
throwaway **Linux or Windows** virtual machines in **their own AWS account** from **reusable
configurations** — install software automatically on boot, connect, then **stop** or **tear down**
when done. Built to the AgentsPoppy framework (`~/Projects/agentspoppy/AGENTS.md` +
`docs/INTEGRATION.md`); this doc records the decisions and the rationale behind them.

> **Boundary:** VM-Poppy is a standalone project. It is *not* MailPoppy and must never touch the
> mailpoppy repo. It runs *on* AgentsPoppy — it does not fork or clone it (FSL non-compete).

---

## 1. What it is (and isn't)

- **A VM manager, not a sandbox.** The reusable object is a **configuration** (a template). The
  "throwaway sandbox for testing other people's poppies" is just *one* config a user might keep;
  the product is general-purpose (dev boxes, CI runners, experiments, detonation).
- **BYO-AWS for the person running it.** VM-Poppy creates EC2 instances in the *user's own* AWS
  account, via the scoped, short-lived credentials AgentsPoppy vends. It never involves a third
  party's account — a vibe-developer being vetted only ever sends *code*, never credentials.
- **The VM has no AWS access inside it.** Instances are launched with **no instance profile / IAM
  role**. Untrusted code on the box therefore cannot reach AWS on its own. This is deliberate
  isolation, and it is also what keeps the poppy's rating clean (see §4).

## 2. Two ways in: Quick and PRO

Both edit the **same** `VmConfig` object; Quick hides everything at sensible defaults.

- **Quick** — pick a size, an OS, a software list, deploy. ~5 fields.
- **PRO** — the same config with advanced sections expanded: instance family/size, arch (arm64/
  x86_64), purchasing (On-Demand/Spot), specific AMI, extra volumes, VPC/subnet/AZ, full firewall
  rules, raw user-data, custom tags, lifecycle. Defaults pre-filled so a non-expert changes one
  thing and leaves the rest.

### The `VmConfig` (persisted locally — see §7)

```
VmConfig {
  id, name                    "Ubuntu dev box", "Detonation sandbox"
  region                      eu-west-1 …  (locks to the connection's account region)
  platform                    "linux" | "windows"
  os                          amazon-linux-2023 | ubuntu-24.04 | debian-12 | windows-2022 …
  arch                        "arm64" | "x86_64"
  instanceType                "t4g.small" (default) …
  amiId?                      explicit AMI override (PRO); else resolved from os+arch+region
  diskGb                      root volume size
  purchasing                  "on-demand" | "spot"
  software[]                  package names installed on first boot
  setupScript?                extra shell (Linux) / PowerShell (Windows) after installs
  access                      "ssh-my-ip" | "airgapped" | custom ingress rules[]
  restrictEgress?             drop outbound (detonation mode)
  autoTerminateHours?         TTL safety net (default on)
  lifecycle                   "reusable" (stop/start ok) | "ephemeral" (self-destruct)
  extraVolumes[]?, subnetId?, tags{}?   (PRO)
}
```

## 3. Architecture

```
Frontend (sandboxed webview)  ──host bridge──►  Host  ──proxy──►  Backend (spawned process)
  Quick/PRO forms, VM list, progress                                 AWS SDK v3 (EC2), configs
        │  invokeBackend({method,path,body})                              │
        └── host.ensureAccess() → user approves ──► host injects BackendBootstrap:
                { connectionId, credentialsUrl, credentialsToken, account }
                                                                          │
   backend mints scoped creds:  POST credentialsUrl  (Authorization: Bearer credentialsToken)
                                                                          │
                                                     EC2: RunInstances / Describe* / Terminate …
```

- **Frontend** — React + Vite, sandboxed (no Node/AWS/fs). Talks only through the host bridge.
  Skinned on the **poppy design kit** (`poppy.css`), accent **`#bccf9e`** (assigned by
  `poppyAccent("com.vmpoppy.desktop")`).
- **Backend** — Node + AWS SDK v3, spawned by the host as a supervised `http` child. Mints
  short-lived tag-scoped creds on demand from `credentialsUrl`; never sees the operator's keys.
  Packaged as a self-contained executable (esbuild bundle → Node SEA) named `vmpoppy-sidecar`.

## 4. Security & the amber rating (the core constraint)

The manifest `permissionSet` is the contract; the host reads and enforces it. VM-Poppy is designed
to rate **amber (medium) with zero beyond-own mutate findings** — *verified* against AgentsPoppy's
real `assessPermissionSet` (cleaner than MailPoppy itself, which carries 3 legitimate reds).

**Three EC2 grants, and why each scope is what it is:**

| Grant | Scope | Why |
|---|---|---|
| `Describe*` (instances, images, types, SGs, VPCs, subnets, AZs, key pairs, volumes) | `*` | Reads. `Describe*` has **no** resource-level permissions in EC2 — `*` is the only option, and reads-on-`*` are amber. |
| `RunInstances`, `CreateSecurityGroup`, `CreateKeyPair`, `ImportKeyPair`, `CreateVolume`, `CreateTags` | `*` | Pure **creates** — additive, cannot harm what exists (amber). They reference untagged/foreign resources (VPC, subnet, AMI) so they *cannot* be tag-scoped. Every create stamps the three attribution tags (§5). |
| `Terminate/Stop/Start/ModifyInstanceAttribute`, `Attach/Detach/DeleteVolume`, `Authorize/Revoke/DeleteSecurityGroup`, `DeleteKeyPair`, **`GetConsoleOutput`, `GetPasswordData`** | **`tagged-as-self`** | Every **mutate-existing** call is limited to resources carrying this connection's tag → it can only ever touch boxes it launched. All these EC2 actions support `aws:ResourceTag`, so the scope is real at AWS, not cosmetic. |

**Decisions of record:**

- **DR1 — No IAM, ever.** VM-Poppy never creates or attaches an IAM role/instance profile. That
  would make the rating **red** (identity creation = escalation) and would give code on the box AWS
  access. Consequence: **no SSM Session Manager** (it needs an instance role) → access is SSH
  (Linux) / RDP (Windows) instead. Accepted.
- **DR2 — No Elastic IP, no termination protection.** EIPs bill after teardown and orphan easily;
  termination protection fights one-click teardown. Both excluded.
- **DR3 — Per-instance reads are `tagged-as-self`, not `*`.** `GetConsoleOutput`/`GetPasswordData`
  live in the mutate grant. Two reasons: (a) we only ever call them on our *own* boxes, so tag
  scope is correct; (b) the risk assessor matches action names by **substring**, and
  `GetConsoleOutput` contains "put" → on `*` it is **falsely** rated a destructive write and turns
  the whole read grant red. Scoping it dodges the false positive *and* is more correct. **Any EC2
  poppy must watch for this substring trap** (Output→"put", others→"set"/"create"/"delete").
- **DR4 — Feasible on the unmodified host.** The `AgentsPoppyBroker` role's ceiling is
  `Allow "*" on "*"` minus guardrail Denies (IAM-user mgmt, account/org, admin-policy attach,
  CloudTrail tamper). EC2 is fully inside that ceiling and untouched by any guardrail, so the
  per-connection session policy narrows `*` down to VM-Poppy's grants. **No AgentsPoppy change is
  required.**

## 5. Attribution & teardown (leave no trace)

- **Every** resource VM-Poppy creates (instance, security group, key pair, volume) is stamped at
  creation via `TagSpecifications` with all three tags:
  `agentspoppy:account`, `agentspoppy:app` (= `com.vmpoppy.desktop`), `agentspoppy:connection`
  (= the injected `connectionId`). This is what makes tag-scoping (§4) *and* teardown real. An
  untagged resource is invisible to the sweep **and** un-mutatable by our own scoped creds.
- **Teardown hook (`POST /teardown`, idempotent) is REQUIRED and is the primary guarantee.**
  Critical framework fact: the host's residual-cleanup backstop covers S3/DynamoDB/Cognito/Lambda/
  Logs/SES **but not EC2**. So VM-Poppy's own hook must fully clean its footprint:
  1. `TerminateInstances` on all instances tagged as this connection's; wait for `terminated`.
  2. Delete tagged security groups (only deletable once no instance uses them → order after 1).
  3. Delete tagged key pairs and any leftover tagged volumes.
  The hook is idempotent (may run more than once / after a partial teardown). `npm run certify`
  runs this with host cleanup **off** and passes only if a `agentspoppy:app` tag sweep is empty.
- **Known limitation (documented honestly):** if the poppy is revoked/uninstalled so the hook
  can't run, leftover EC2 is **listed to the user with console links** by the host sweep but not
  auto-deleted (no EC2 host backstop). In-app teardown is therefore the recommended path. Self-
  terminating "ephemeral" configs (§6) mitigate this for the disposable case.

## 6. Lifecycle: reusable vs ephemeral, and self-termination

- **reusable** (default): shutdown behavior = *stop*, so **Stop/Start** preserves the box and its
  installed software (small EBS cost while stopped). `autoTerminateHours` is a best-effort timer
  the backend enforces while the app is open, plus manual **Tear down**. Default TTL **on**.
- **ephemeral** (opt-in, ideal for detonation/vetting): `InstanceInitiatedShutdownBehavior=terminate`
  + a hard `shutdown -h +N` in user-data → the box **self-destructs** even if the app is closed,
  and `DeleteOnTermination` wipes its volume. No Stop/Start. Needs **no IAM role and no Lambda** —
  the cost guarantee is baked into the instance.

## 7. Software install & progress — without any IAM

- **Install = cloud-init user-data** generated from `software` + `setupScript`: `apt`/`dnf` for
  Linux, PowerShell + winget/Chocolatey for Windows. Fully automatic on first boot.
- **Progress without an instance role:** the generated script prints a sentinel
  (`VMPOPPY_INSTALL_COMPLETE`) at the end; the backend polls **`ec2:GetConsoleOutput`** (a read on
  our own tagged instance) and flips the UI *Installing… → Ready* when it appears. No SSH-key
  custody needed, no instance IAM role, no Lambda. Console output lags a few minutes — honest and
  zero-privilege.

## 8. Access: SSH (Linux) / RDP (Windows)

- **VM-Poppy generates + locally stores the key pair** (`CreateKeyPair`, private key under
  `~/.vmpoppy/keys/`, offered for download; tagged, deleted at teardown). Chosen over "user brings
  their own key" because it makes one-click SSH and **Windows Administrator-password retrieval**
  (`GetPasswordData` + local decrypt) work with no extra steps. The private key never leaves the
  user's machine (same trust level as `~/.aws`).
- Firewall: a tagged security group opens **SSH 22** (Linux) / **RDP 3389** (Windows) to the
  **user's current public IP only** by default. `airgapped` opens nothing; PRO allows custom rules.
  `restrictEgress` drops outbound for detonation (breaks package installs — surfaced clearly).

## 9. Config persistence

Saved `VmConfig`s are user preferences, not cloud state, so they live **locally** in
`~/.vmpoppy/configs.json` (written by the backend, same pattern as MailPoppy's ledger). No S3/
DynamoDB → nothing extra to provision or tear down. **Live VM state is never read from here** — it
is always reconstructed from `DescribeInstances` by tag (§10).

## 10. Background & resume (framework requirement)

Deploys/installs run server-side and can take minutes. On every mount the frontend reconstructs
the running-VM list from **`DescribeInstances`** filtered by the connection tag — never from
`localStorage`. An in-flight launch/install re-attaches its poller; a finished one shows Ready; a
failed one shows the failure + retry. Navigation is never blocked.

## 11. Destructive-action ceremony (framework requirement)

Every destroy control (**Tear down a VM**, **Remove everything**) uses a two-step confirm that
names the blast radius (which instances/volumes, that it's irreversible). "Remove everything"
uses **type-to-confirm** (the config or poppy name). Focus defaults to Cancel; the danger button is
styled as danger and never single-click.

## 12. Repo layout

```
vm-poppy/
├── extension.json            # the manifest (validated; amber, 0 red)
├── DESIGN.md                 # this file
├── README.md
├── package.json · tsconfig.json · .gitignore
├── frontend/                 # React + Vite on poppy.css → dist/
│   ├── index.html · vmpoppy-icon.png
│   └── src/ …
├── backend/                  # Node + AWS SDK v3 → SEA "vmpoppy-sidecar"
│   └── src/ { server, boot, ec2, userdata, configs, teardown, types }
└── scripts/                  # build-sidecar, gen/validate-manifest, certify passthrough
```

## 13. Build → install → run

1. `npm run build` — frontend (`vite build` → `frontend/dist`) + backend (esbuild → SEA
   `backend/vmpoppy-sidecar`).
2. Install into AgentsPoppy for local testing:
   `node ~/Projects/agentspoppy/scripts/install-dev-extension.mjs --src ~/Projects/vm-poppy
   --frontend frontend/dist --backend backend/vmpoppy-sidecar`
3. Relaunch AgentsPoppy (`npm run -w @agentspoppy/app tauri:dev`), open the VM-Poppy tab, approve
   the connection, confirm the amber rating with **no beyond-own findings**.
4. After deploy → use → tear down: `npm run certify` (in agentspoppy) must sweep clean.

> **Gotcha (mirrors MailPoppy's stale-sidecar trap):** the backend ships as a prebuilt SEA. After
> changing backend or user-data code you MUST rebuild the sidecar and fully relaunch AgentsPoppy —
> a frontend-only reload won't pick it up.

## 14. Status

- ✅ Framework studied; feasibility confirmed on the unmodified host (DR4).
- ✅ `extension.json` written, **validated**, and **rating-verified amber / 0 red** against
  AgentsPoppy's real `parseManifest` + `assessPermissionSet`.
- 🚧 Project scaffolding.
- ⬜ Backend (EC2 launch/list/lifecycle/teardown, user-data gen, config store, cred minting).
- ⬜ Frontend (Quick + PRO, VM list, progress, connect, destructive ceremonies) on the design kit.
- ⬜ Build/packaging (SEA sidecar), live end-to-end test in a throwaway account, certify.
