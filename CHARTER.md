# CHARTER — atacolak/deepseek-harness

Private capability fork of [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness). It runs the operator's DSH Web profile on the NetBird WireGuard mesh, federated to the CPA model proxy, with no telemetry and no vendor sign-in.

## Purpose

- Serve the DSH Web carrier at `http://10.77.67.147:3080` on the private `10.77.0.0/16` mesh (`wt0`), reachable from any peer on that network without a launch token.
- Send every model request to the CPA federated proxy (`https://proxy.net.colak.sh/v1`) through one bearer credential referenced by environment variable name (`CPA_API_KEY`), never a vendor API key committed to a config file.
- Stay buildable from this fork alone: `pnpm install && pnpm run build` on Node 24.

## Branch discipline

- `master` mirrors `upstream/master`. It is never edited here; it only fast-forwards.
- Every capability is one branch, `cap/<slug>`, cut from `master` and pushed to `origin`.
- One capability per branch, with its source, unit tests, package README pair, and JSDoc contracts in the same commit series.
- Upstream sync: `git fetch upstream && git rebase upstream/master` on the capability branch, then re-run that capability's targeted suites and `pnpm run build`.
- A capability merges into this fork's `master` only after its suite is green and the operator has reviewed the branch. Use `--force-with-lease` on your own capability branch and never raw `--force`.
- No vendor SDK additions, telemetry shims, or desktop packaging changes on capability branches.

## Telemetry zero-policy

- This fork ships no analytics, crash reporting, usage ping, or vendor sign-in prompt. The deployed `~/.dsh/profiles/web/cordis.patch.yml` disables the upstream telemetry and DeepSeek account rows; the repository keeps those capabilities opt-in.
- Diagnostics stay local: systemd/journald logs and `~/.dsh` state. Nothing leaves the mesh.
- Credentials arrive from the deployment environment (`EnvironmentFile`), are never committed, and are never printed, echoed, or logged.

## CPA / OMP integration

- DSH reaches models through an OpenAI-compatible base URL (`https://proxy.net.colak.sh/v1`) and a single bearer credential named by environment variable (`CPA_API_KEY`).
- CPA owns provider routing, key rotation, and quota. DSH owns the session, tools, and the Web carrier.
- OMP operates the deployment: it authors `~/.dsh/profiles/web/cordis.patch.yml`, the `dsh-web` unit, and the capability branches in this fork.

## Capabilities

| Branch | Contract |
|---|---|
| `cap/mesh-auth` | `DSH_TRUST_MESH_CIDRS` (comma-separated IPv4 CIDRs) admits an unauthenticated `GET /` whose socket address falls inside a listed subnet: `BrowserAuth` mints the same signed `HttpOnly; SameSite=Strict` `dsh-auth-*` cookie the launch-token exchange mints and redirects `303` to `./`. IPv4-mapped addresses read as IPv4. Unset or empty keeps upstream behavior unchanged (401). A malformed entry fails Connection activation. |

## Build and runtime pins

- Node `v24.22.2` with `/home/sf/.nvm/versions/node/v24.22.2/bin` first on `PATH`; pnpm `11.28.5` through Corepack.
- `pnpm run build` runs the native addon, Typert generation, the Host and Client compilers and bundles, the Desktop main-process bundle, the Web build, and both aggregate type checks. Desktop Electron packaging is not part of the build.
- The deployed unit executes `apps/cli/lib/bin.js`, a build artifact: run `pnpm run build` before restarting after any rebase or source change, and keep `WorkingDirectory` at the clone root so its module resolution stays intact.

## Repository notes

- `origin` = `atacolak/deepseek-harness` (push target); `upstream` = `deepseek-ai/deepseek-harness` (fetch only).
- The clone is blobless (`--filter=blob:none`); `git fetch` and checkouts fetch file contents on demand.
