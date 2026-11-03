# @deepseek-ai/dsh-omp-rpc

Bridge between a Harness Agent and one OMP RPC process. The Agent's turn is
served by OMP; every OMP step is projected back into the Harness Session as
ordinary `assistant/message` and `tool/result` events, and selected Harness
tools are published to OMP as discoverable host tools.

## Presets

`discoverOmpPresets` mirrors `omp --agent` discovery: project `.omp/agents`
directories from the working directory upward, then `~/.omp/agent/agents`.
Only the human profiles listed in `HUMAN_OMP_PROFILES` (`argon`, `lead`,
`squad-actor`) enter the Harness roster, as `omp:<profile>`; `argon` sorts
first. A harness preset built this way composes no plugins of its own — OMP
serves the whole step.

## Commands

| Command | Behavior |
| --- | --- |
| `/omp-attach <id-or-prefix> [profile]` | Resume a transcript from the unified sessions root in place, hydrating its recorded bubbles. |
| `/omp-resume <id-or-prefix> [profile]` | Same open path as `/omp-attach`; the launchpad's canonical resume command. |
| `/omp-fork [profile]` | Start a fresh OMP transcript and replay this Session's history into it. |

Opening refuses a transcript that another OMP pane still holds. Hydration only
runs on a blank Session and replays the newest 200 recorded surface events, so
the chat shows real user/assistant/tool bubbles rather than one seed message.

## `POST /api/exocortex/omp/open`

Authenticated Fetch route registered on the Host connection service. It opens a
resolved transcript in a live Session, or creates a Session first.

```json
{ "ompSession": "<id-or-prefix-or-absolute-path>", "sessionId": "<live-session>", "profile": "argon", "cwd": "/abs/dir" }
```

`ompSession` is required. `sessionId` selects an existing Session; without it a
Session is created with `cwd` (or the transcript's recorded cwd) and the
`profile` preset (`omp:<profile>`). Success returns `sessionId`, optional
`agentPreset`, the `ompSession` identity (`id`, `path`, optional `cwd` and
`profile`), `hydrated` event count, and a human `summary`. Errors use
`{ "error": { "code", "message" } }` with 400/404/409/413 statuses for
request, transcript, lease, and body-size failures.

## Configuration

| Key | Default | Purpose |
| --- | --- | --- |
| `executable` | `omp` | OMP binary name or absolute path. |
| `sessionDir` | `~/.omp/agent/sessions` | Transcript root OMP writes into. |
| `ompSessionsRoot` | `~/.omp/agent/sessions` | Root `/omp-resume` and the open route resolve. |
| `preset` | unset | Default `--agent` profile. |
| `hostTools` | `cordis_inspect_list`, `cordis_inspect_query`, `plugin_manager` | Discoverable Harness tools published to OMP. |
| `cwd` | unset | Fallback working directory when the Session header has none. |
| `home` | process home | Home owning `~/.omp/agent/agents`. |
| `autoAttach` | true | Attach OMP-preset Sessions on turn 1. |

Both transcript roots intentionally default to the one OMP sessions directory:
an interactive OMP run and a Harness-opened run share transcripts, ids, and
downstream resume links.
