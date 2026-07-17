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
| `DescribeInstances/Images/SecurityGroups/Vpcs/Subnets` | `*` | Reads the backend actually performs. `Describe*` has **no** resource-level permissions in EC2 — `*` is the only option, and reads-on-`*` are amber. |
| `RunInstances`, `CreateSecurityGroup`, `CreateKeyPair`, `CreateTags` | `*` | Pure **creates** — additive, cannot harm what exists (amber). They reference untagged/foreign resources (VPC, subnet, AMI) so they *cannot* be tag-scoped. Every create stamps the three attribution tags (§5); `CreateTags` is what tagging-on-create (`TagSpecifications`) requires. |
| `Terminate/Stop/StartInstances`, `AuthorizeSecurityGroupIngress`, `RevokeSecurityGroupEgress`, `DeleteSecurityGroup`, `DeleteKeyPair`, **`GetConsoleOutput`, `GetPasswordData`** | **`tagged-as-self`** | Every **mutate-existing** call is limited to resources carrying this connection's tag → it can only ever touch boxes it launched. All these EC2 actions support `aws:ResourceTag`, so the scope is real at AWS, not cosmetic. |

**The set is exactly the calls the backend makes — nothing speculative.** v0.1.1 shipped 31
actions (volumes, ImportKeyPair, ModifyInstanceAttribute… for unshipped features) and STS
rejected the vend: *"Packed policy consumes 118% of allotted space"* — the broker's inline
session policy (one statement per grant, actions verbatim) + the three session tags overflow
STS's packed budget long before the nominal 2048-char plaintext limit. Trimming to the 18
actually-used actions → 736 chars ≈ 82% packed. **Lesson (DR5): the framework's "over-asking
is a defect" rule is mechanically enforced by STS — declare only what you call, and re-add
actions in the release that ships the feature needing them (a manifest change triggers
re-approval anyway).**

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
  installed software (small EBS cost while stopped). Manual **Tear down** is always available.
- **ephemeral** (opt-in, ideal for detonation/vetting): `InstanceInitiatedShutdownBehavior=terminate`
  + a hard `shutdown -h +N` in user-data → the box **self-destructs** even if the app is closed,
  and `DeleteOnTermination` wipes its volume. No Stop/Start. Needs **no IAM role and no Lambda** —
  the cost guarantee is baked into the instance.

> **⚠️ KNOWN UX GAP — `autoTerminateHours` on a reusable box does nothing (fix before promoting).**
> The self-shutdown is written into user-data **only for ephemeral** configs (§7). A *reusable* box
> keeps `shutdown` behaviour = stop (so Stop/Start works), so it can't self-terminate — yet the
> launch form still shows the "auto-terminate after (hours) — safety net" field for it, implying a
> guarantee that isn't wired. A user who picks "Keep it" and forgets keeps **billing compute**
> indefinitely. Resolve one of two ways:
> 1. **Make the timer real for reusable** — e.g. a tiny per-connection EventBridge Scheduler +
>    `TerminateInstances` rule in the footprint (adds an IAM role → would push the rating to red,
>    so undesirable), OR a self-scheduled `shutdown` that only *stops* at the TTL (cheaper: halts
>    compute, leaves the disk), OR a backend/host cron that terminates aged tagged boxes. Prefer the
>    stop-at-TTL variant to keep the amber, no-IAM posture.
> 2. **Hide the field unless ephemeral** — simplest honest fix: only render the "auto-terminate"
>    control when lifecycle = "throwaway", so the UI never promises a safety net it can't keep.
> (Interim guidance already given to the user: use **ephemeral** for a real cost cap; tear down
> reusable boxes manually.)

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

**Shipped today:** persistence (`GET`/`POST`/`DELETE /configs`) + a **"Saved configurations"** list
in the UI with **Deploy / Edit / Delete**. Deploying a saved config launches a *fresh* box from it,
so the core "define once → deploy-and-throwaway repeatedly → pick the config back up" loop already
works (pair it with the **ephemeral** lifecycle).

> **FOLLOW-UP — "Save without launching".** A config is currently persisted only as a side effect of
> **Deploy** (`launch()` saves it). There's no standalone **Save** button, so you can't stash a
> config (e.g. a long software list) to reuse *later* without deploying it once first. The backend
> already supports it (`POST /configs`); this is a **frontend-only** add: a "Save configuration"
> button in the launch form that calls `api.saveConfig(config)` and refreshes the list, plus letting
> the user name/duplicate a config. Small; bundle with the other UI polish (§6 auto-terminate field).

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

1. `npm run build` — frontend (`vite build` → `frontend/dist`) + backend **Node SEA**
   (`scripts/build-sidecar.mjs`: esbuild→CJS → SEA blob → lipo-thin → strip → postject
   inject → ad-hoc codesign → `backend/vmpoppy-sidecar`, a self-contained executable that
   needs no Node installed). The output is a **native arm64** binary embedding Node 22.
   **Cross-arch note:** esbuild is installed x86_64, but the base must carry the machine's
   native slice — the script auto-re-execs under a universal node's x86_64 slice (Rosetta)
   so `npm run build:sidecar` "just works" on Apple Silicon. Detects true hardware arch via
   `sysctl hw.optional.arm64` (not `uname -m`, which lies under Rosetta).
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

**Released:** v0.1.0 (first catalogue listing) → v0.1.1 (supervised-approval credential minting) →
v0.1.2 (trimmed permission set so the STS session policy fits) → v0.1.3 (Windows-connect fix + UX
polish batch) → v0.1.4 (app-scoped listing/teardown — fixes orphaned VMs) → v0.1.5 (billing
clarity: live run-rate + teardown terminology + Save-config) → **v0.1.6** (test-session batch:
Edit-saved-config remount fix, Windows-password not-ready auto-poll, labeled id/address + copy
buttons, RDP exit + stopped/Start guidance; **first dual-platform release — darwin-arm64 +
win32-x64**, live-verified on Windows Server 2022). Live-tested against the user's real AWS.

**Queued for v0.1.7 (from live Windows testing 2026-07-15):**
- ✅ *(committed)* Software-field hint: names are Chocolatey/apt package names, with the Chrome
  example and a "Look up a name →" link; misspelled names are skipped, not fatal.
- **Say that editing a config only affects FUTURE deployments.** The user edited a saved config
  (added `googlechrome`) and expected the running VM to gain it — installs run once at first
  boot. Add a line to the edit form ("changes apply to the next deploy — running boxes keep
  their software") and consider an "Install on running box" affordance later.
- ✅ *(committed)* **"Download SSH key" gave zero feedback** and saved silently to ~/Downloads
  (user: "the button was completely unresponsive... didn't let me choose where"). Button now says
  "Save SSH key to Downloads" upfront, shows Saving…/✓ Saved states. A real "save as" dialog needs
  a new HOST capability (host:saveFile) — candidate for the AgentsPoppy platform backlog.
- **Surface per-package install failures.** `choco install googlechrome` can fail a checksum
  when the package lags a Chrome release; the script deliberately continues, so the failure is
  silent (only in `C:\vmpoppy-install.log` / `/var/log/vmpoppy-install.log`). Emit per-package
  OK/FAIL lines to the serial console next to the sentinel so the app can show "chrome failed
  to install" on the card instead of implying success.

**v0.1.5 shipped (2026-07-15) — "billing clarity" batch.** ✅ **Live run-rate** above the VM list —
"Running now: N boxes ≈ $X/hr" from the app's own inventory × `HOURLY_USD`, and a reassuring "Nothing
running — you're not being billed for compute · $0/hr" when empty (compute-only estimate; stopped
boxes noted separately) · ✅ **Teardown terminology** — the confirm dialog names AWS's word ("terminate
= delete; stops billing immediately; shows as **Terminated** ~1h then disappears"), `shutting-down`
reads "terminating…", and a post-teardown notification confirms "no longer billing" instead of the card
silently vanishing · ✅ **Save config** button (calls the existing `POST /configs`). *Deferred:* region
picker, live Price List API, per-poppy/actual month-to-date (host-side).

**v0.1.4 shipped (2026-07-15) — CRITICAL orphan fix.** `ownInstancesFilter` (and the ownership
guard + teardown sweep) filtered by `agentspoppy:connection` = the *current* connection id. But every
manifest-scope change **supersedes** the connection (revoke + recreate with a new id), while the VMs
it created keep the *old* connection tag. Result: after an update, a running VM became **invisible in
the new connection's list AND untouched by its teardown** — an orphaned, still-billing instance. Fix:
scope listing/guard/teardown to the stable **`agentspoppy:app`** tag (matching the broker's own
app-scoped session policy), so all of VM-Poppy's VMs are visible + manageable across supersedes. Also
hardened per-VM cleanup: the security-group delete now **retries through `DependencyViolation`** (the
ENI detaches a few seconds after `terminated`, so the old single 4s attempt leaked the SG).
**Lesson (DR6): scope by the app tag, never the connection id — connections are ephemeral, the
resources outlive them.**

**v0.1.3 shipped (2026-07-15):** ✅ Windows VMs no longer mislabelled as Linux (the lowercase
`Platform` wire-value trap; now a `vmpoppy:platform` tag + case-insensitive detection) · ✅ teardown
button shows an immediate "Tearing down…" spinner (was firing with no feedback) · ✅ number inputs no
longer render "0"/concatenate to "04" · ✅ prices show explicit USD (`~$0.017/hr`) + "approx" label ·
✅ auto-terminate field hidden on reusable boxes (+ a "keeps billing until you stop/tear down" note) ·
✅ install "installing" copy reassures + softens after ~6 min. *Still open:* live pricing via the
Price List API (§14), "Save configuration" button (§9), region picker, reusable stop-at-TTL.

- ✅ Framework studied; feasibility confirmed on the unmodified host (DR4).
- ✅ `extension.json` written, **validated**, and **rating-verified amber / 0 red** against
  AgentsPoppy's real `parseManifest` + `assessPermissionSet`.
- ✅ Project scaffolding.
- ✅ Backend (EC2 launch/list/lifecycle/teardown, user-data gen, config store, cred minting) —
  typecheck clean, 9 unit tests pass.
- ✅ Frontend (Quick + PRO, VM list, progress, connect, destructive ceremonies) on the design
  kit — typecheck + production build clean, design-kit compliant.
- ✅ Build/packaging — native arm64 **Node SEA** sidecar; boots ~2s, HTTP routes verified
  (health/meta/configs OK; AWS routes reach the credential mint).
- ⬜ Live end-to-end test inside AgentsPoppy against a throwaway AWS account (install-dev →
  approve → deploy a VM → connect → teardown), then `npm run certify`.
- ⬜ **FEATURE: region picker (not just UI polish).** Today every VM deploys in
  `boot.account.region` (AgentsPoppy's `account.regions[0]`, default `us-east-1`); the EC2 client is
  pinned to it at spawn ([server.ts:14](backend/src/server.ts)) and the `VmConfig.region` field is
  **dead code** — unread, no UI control. To let the user choose per-config region:
  1. **Per-region clients** — build the EC2 client from `config.region` at launch (brokered STS
     creds are account-wide, so they work in any region — creds are *not* the blocker).
  2. **Multi-region listing** — `DescribeInstances` is per-region, so "Running VMs" must fan out
     across the regions the user has actually deployed to (track per-config/per-instance region, or
     query a known set). This is the real work — the single fixed client today hides it.
  3. **Default-VPC-per-region gotcha** — `resolveVpcId` uses the *default* VPC of the target region;
     a region without one fails launch. Surface a clear message + the PRO subnet override.
  Expose region as a **Quick-mode dropdown** (SES-style region list isn't needed — EC2 is in all
  regions). A later minor version, after the v0.1.3 polish.
- ⬜ **UX: `autoTerminateHours` on reusable boxes** — the field is shown but not enforced (§6 known
  gap). Either make the timer real (stop-at-TTL, keeping amber/no-IAM) or hide the field unless the
  "throwaway" lifecycle is selected. Do this before promoting the poppy widely.
- ⬜ **UX: install-progress reassurance + soft timeout** — "installing" is detected via
  `GetConsoleOutput`, which lags several minutes on EC2, so the badge sits on "installing" long after
  the box is connectable and can look *stuck*. Fixes: (a) a reassurance line — *"First launch installs
  your software; this can take a few minutes — you can connect as soon as the box is running"*;
  (b) a **soft timeout** — after ~6 min still "installing", soften the copy to *"install may still be
  finishing — you can connect and check"* rather than an indefinite spinner. (c) Emphasise that the
  **connect panel is already available while installing** (it is, but make it obvious). Frontend-only;
  v0.1.3. **Deeper follow-up (later):** the sentinel-via-console signal is inherently fragile — a more
  reliable "reachable" signal is EC2 **instance status checks** (`DescribeInstanceStatus`, 2/2 ok),
  which I *removed* in the v0.1.2 policy trim; re-add that small grant and split "reachable" (status
  checks, reliable) from "software installed" (console sentinel, best-effort) so connecting is never
  gated on the flaky signal.
- ⬜ **UX: teardown terminology + reassurance (from real user anxiety)** — the app said "tearing
  down" while AWS says **"Terminated"**, with nothing connecting them, so the user couldn't tell if
  the VM was *stopped* (still billing) or *gone*. Fix (AGENTS.md §9 "name the real thing + explain
  it"): (a) confirm dialog names the AWS word up front — *"permanently **terminates** it (AWS's word
  for deleted); stops billing immediately; shows as **'Terminated'** in your console for ~1h then
  disappears"*; (b) a post-teardown **confirmation** (host notify or banner) — *"'<name>' terminated —
  fully deleted, no longer billing"* — instead of the card silently vanishing; (c) plain state labels
  that still match AWS — `shutting-down` → "Terminating…", and a brief "Terminated ✓ — deleted, $0".
  Frontend-only; v0.1.5. **Host-side counterpart → agentspoppy roadmap:** the dashboard's connection
  teardown + Resources view should use the same AWS-matching-but-explained language for *every* poppy.
- ⬜ **UX: number inputs render `0` / concatenate to `04`** — `LaunchForm.tsx` binds
  `value={cfg.autoTerminateHours ?? 0}`, so clearing the field (`Number("")||undefined`) shows the
  literal "0"; typing `4` then appends → "04". Fix: `value={… ?? ""}` (empty, not "0") + `min={1}`,
  and parse `""`→undefined on change. Same shape on the PRO **Root disk** input (line ~132). Trivial
  frontend fix; v0.1.3.
- ⬜ **UX: "Save configuration" button** (§9 follow-up) — persist a config without deploying it,
  so a long-software template can be stashed and reused later. Backend endpoint already exists;
  frontend-only. Bundle with the auto-terminate field fix as a v0.1.3 UI-polish release.
- ⬜ **UX: price display — hardcoded now, LIVE later.** `SIZE_CATALOG` (frontend/src/types.ts) carries
  strings like `~1.7¢/hr`. **v0.1.3 (frontend-only):** explicit USD (`~$0.017/hr`, not the ambiguous
  `¢`) + an **"approx · varies by region/OS"** label. **Proper fix (later, small backend feature):**
  query the **AWS Price List Query API** (`pricing:GetProducts`) live for the instance types VM-Poppy
  offers, in the connected region → always-current prices, kills the stale-hardcoded problem.
  *(Correction to an earlier note here: the "Pricing API is too big / eats policy headroom" objection
  was overstated. A FILTERED query returns one price, not the bulk offer file; the grant is a single
  read-only `pricing:GetProducts` — stays amber, ~+100 chars of session policy, well within budget.)*
  Caveats: the Pricing API is only callable from a pricing-enabled region (us-east-1), so it needs a
  second client there; the per-item price is buried under `terms.OnDemand.…pricePerUnit.USD` (fiddly
  but bounded) — cache per (instanceType × region × OS).

- ⭐ **HIGH PRIORITY — live "run-rate" cost indicator (poppy-side, anxiety-killer).** Users
  repeatedly ask to *see current billing*; the deepest need is simply **"is anything billing right
  now?"** VM-Poppy already lists its running VMs + instance types, so it can sum the hourly estimates
  and show a live line — *"Currently running: 1 × t3.large ≈ $0.08/hr"* — and, crucially, **"Nothing
  running — $0/hr"** when empty. No Cost Explorer, no new grant, no 24h lag. Caveats to surface: it's
  an estimate (Windows/region nudge it), it's **compute-only** (a *stopped* box still bills a little
  for its disk — count stopped boxes separately as "~$X/mo disk"). This is the single most reassuring
  thing we can add; do it early (v0.1.5/0.1.6). The exact *actual* spend is tiers 2–3 below.

### Boundary note — cost *estimates* are the poppy's job; actual *spend* is the host's

Deliberately **NOT** a VM-Poppy feature: **month-to-date cost** and **forecasted month-end cost**
(`ce:GetCostAndUsage` / `ce:GetCostForecast`). Those are **account-wide financial data** — a poppy
showing the whole account's spend is both wrong (it's not *its* cost) and an over-grant (`ce:*` reaches
far beyond "its own resources"). They belong to **AgentsPoppy (the host)**, which already holds the
operator credentials + the account-wide view. Nice synergy for the host to exploit: every resource is
already stamped `agentspoppy:app`, and Cost Explorer can **group by tag**, so the host can show a
**per-poppy cost breakdown** ("VM-Poppy cost you $X this month") reusing the attribution tags that
already exist for teardown. Host-side caveats: Cost Explorer lags ~24h + costs $0.01/request, and the
`agentspoppy:app` tag must be **activated as a cost-allocation tag** in Billing (one-time, no backfill).
→ Logged for the **agentspoppy** roadmap, not this repo. The clean split: the poppy **quotes** (price
list), the host shows the **invoice** (Cost Explorer).
