# exocortex

**a second cortex for people who refuse to be the glue.**

persistent agents. composable workspaces. software you reshape in place.

your work should not disappear behind conversations. open a workspace, inspect a decision, change a tool, address its owner, and carry on where you were. the system should remember the connections so you do not have to.

> [!NOTE]
> this is [exocortex](https://github.com/atacolak/exocortex), a derivative of [deepseek harness](https://github.com/deepseek-ai/deepseek-harness), built on [cordis](https://github.com/cordiverse/cordis).
>
> exocortex's direction is workspace-first: OMP executes, actors persist, and plugins compose the interface. upstream ancestry, licensing and attribution remain intact. inherited package names and `dsh` commands are implementation identifiers, not the product's identity.
>
> this is an actively developed fork, not a claim that every capability described below is delivered. deployment checkouts track acceptance in their workspace requirements ledger; actual runtime evidence determines what is loaded and usable.

## a workspace, not a waiting room

the primary surface is the thing you are working on: a project, board, actor, factory, plugin, machine or artifact. conversation can sit beside it. it does not have to swallow it.

- **workspaces and estate:** a place for each domain; clear ownership, attention and return paths.
- **work and provenance:** list and kanban over the same work records; intent, dependencies, attempts and evidence one inspection away.
- **actors:** create a collaborator, give it a purpose and capabilities, then change them without managing terminal sessions or editing configuration by hand.
- **factories and automations:** author supported repeatable work, see its actual runs, intervene and recover. a diagram is not an execution engine.
- **plugins and co-building:** point at a surface, talk to its plugin manager, see a candidate beside the conversation, refine it and keep or revert it.
- **models, machines and knowledge:** inspect what is actually running, what it can access, what it remembers and where that information came from.

these are connected views of existing objects, not six new databases. changing views must preserve drafts, selection, focus and place.

## an actor is someone you can return to

an actor is a persistent, addressable collaborator with a purpose, project home, effective configuration and continuity of work. its current model supplies inference. its execution runs the work. its windows show that work.

| concept | meaning |
| --- | --- |
| actor | stable identity, responsibilities and addressability |
| profile | reusable instructions and configuration, with explicit actor overrides |
| model route | the selected inference provider/model and its actual runtime state |
| execution | a particular running or resumable session, with canonical history |
| view | a browser or terminal attachment; not a second actor |
| workspace | the project/domain home that supplies relevant work and memory scope |

**open attaches. close detaches. stop stops.** those are different actions. opening another view must not create another execution; changing a model must not change identity; editing one actor must not silently modify everyone using its profile.

creation starts with **name, purpose, workspace and a useful preset**. the inspector exposes the rest: instructions, tools, MCP connections and grants, skills, knowledge/memory, model routing, execution policy and permissions. inheritance stays visible. saved, applied and available to the running model are separate states.

## the seams that matter

| boundary | owns | does not own |
| --- | --- | --- |
| widgets | presentation and interaction | a private copy of domain truth |
| services | authoritative reads, mutations and events | operator layout |
| views | selection, focus, layout and attachment | actor lifetime |
| runtime | execution, history and effective capabilities | a second browser-owned agent loop |
| development loop | isolated candidates, evidence, integration and revert | permission to overwrite everyone's live surface |

OMP owns execution and canonical session events. HCOM/actor services own durable identity and messaging. beads owns tracked work. hindsight holds learned project knowledge. systemd-ops owns operational lifecycle. cordis supplies composition and lifecycle boundaries. use those authorities; do not build another registry, scheduler or shadow transcript because a screen needs data.

## if you are working here

**make the next useful action obvious. make the result real. leave the operator's place intact.**

1. read [AGENTS.md](AGENTS.md). in a managed deployment checkout, also read its `CHARTER.md` and existing workspace requirements ledger. find your assigned requirement; do not start another roadmap or invent missing project policy.
2. resolve the exact target: workspace, actor or record, view, slot, loaded revision and candidate revision. your own conversation is not automatically the surface being edited.
3. inspect the live plugin catalog, then the responsible producer and consumer. remembered contracts and convenient test fixtures are not runtime evidence.
4. use an existing plugin/service seam. a genuinely missing seam warrants a small owned extension, not feature UI buried in the harness core.
5. change the isolated candidate. inspect the real interaction. show the object or result, not a narration of your diligence.
6. integrate with the existing owner. check base drift and combined behavior. a clean text merge does not establish compatibility.

### keep the loop fast without lying about it

client edits can use hot replacement. host changes need a supported activation path. shared runtime changes need staged integration. determine which you are making before promising instant delivery.

measure separately: prompt-to-useful-action, artifact-write-to-paint, and inspection time. a fast model and a 500ms watcher do not prove a 500ms feature.

parallel feature conversations need independently rendered candidates. separate git branches or chat tabs do not isolate a document-wide module graph, shared host service or backend write. stage URLs and directory names are not proof of isolation.

### report what changes the next action

- identification: an actionable object reference and a short answer.
- small edit: the visible candidate, where to inspect it, and any material limitation.
- blocker: the consequence and next action.
- design decision: the recommendation and the trade-off that matters.

put detailed diffs, test output and source history in linked evidence. keep failures and uncertainty visible. **committed, built, loaded, visibly verified and operator-accepted are not synonyms.**

## memory and orientation

project workers belong to the declared **exocortex** project, including legitimate project worktrees. a generic parent directory is not a project memory scope. verify the resolved recall and retention target; a profile's knowledge-page allowlist does not establish either one.

use hindsight for decisions, rationale and hard-won lessons. use the live catalog and source for current plugin contracts. record a useful finding with its source, revision and relevant plugin area; do not retain routine tool noise or invent success from a test count. actor attribution is provenance, not a wall between collaborators' project knowledge.

### living knowledge map

these are internal agent resources, read with the `read` tool when authorized. they are not public web URLs and are not required to browse this repository.

| resource | read it for |
| --- | --- |
| `knowledge://projects/exocortex/architecture` | component boundaries, canonical stores, execution/bridge contracts and composition |
| `knowledge://projects/exocortex/decision-history` | why constraints exist, alternatives rejected and later supersessions |
| `knowledge://projects/exocortex/active-initiatives` | continuing workstreams and their architectural context |
| `knowledge://shared/engineering-principles` | shared engineering judgment, verification and ownership boundaries |
| `rule://exocortex-plugin-sla` | plugin boundaries and measured interaction-performance targets |
| `skill://cordis-plugin-development` | discovering, composing, activating and verifying plugin capabilities |

load the relevant page, not the entire archive. knowledge can lag: verify paths, loaded code and delivery state against the current repository/runtime. project workers use project and declassified shared knowledge; private personal memory is not an implicit grant.

### repository map

- [AGENTS.md](AGENTS.md): worker rules, code placement and verification.
- managed deployment checkouts also carry `CHARTER.md` (product constraints) and `docs/workspace/REQUIREMENTS-LEDGER-2026-11-07.md` (scope, evidence and remaining gates). these local operational documents are not prerequisites for browsing the public branch and are not published merely to populate this map.
- [development guide](docs/development.md): inherited build and development mechanics.
- [architecture documentation](docs/architecture.md): harness foundations; check fork-specific contracts before applying upstream assumptions.
- deployment branches use `packages/acp/omp-rpc/` for the OMP execution bridge; verify that it exists in the selected revision before assuming that integration is available.

`@exocortex/*` product bundles may be maintained in a separate deployment repository. that repository has its own instructions and access boundary; this public fork does not include or grant access to private bundle history. sharing a project memory scope does not merge repositories or permissions.

## development and safety

start with the [development guide](docs/development.md), repository-declared toolchain and [safety notice](SAFETY.md). upstream npm packages run upstream software; they are not an installer for this fork's complete workspace deployment.

build and verify away from an active operator runtime. do not partially replace shared client chunks, restart a parent execution host mid-turn, or test against existing conversations merely because their files are under a staging directory. preserve recoverable inputs and make failed operations retryable without replaying unapproved side effects.

credentials travel from a trusted input surface to an authorized secret consumer. models receive scoped references and status, never raw credential values in chat, tools, logs, screenshots or memory. a masked text field alone is not a protected path.

## lineage and license

exocortex derives from [deepseek harness](https://github.com/deepseek-ai/deepseek-harness), created by deepseek ai, and builds on cordis. the upstream composability research is described in [a programming paradigm for spatiotemporal composability](https://arxiv.org/abs/2608.25512).

[MIT license](LICENSE). retain the original notices. third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
