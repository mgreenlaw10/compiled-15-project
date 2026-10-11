# Collaborative AI development over Git

Multiple developers and AI agents work on one project at the same time. The
architecture graph becomes the shared interface: it shows the structure, who is
working on what, which agents are running, and which concurrent changes might be
incompatible.

**Git is the only synchronization mechanism.** There is no server, no database,
no WebSocket. Collaboration is a shared remote, an orphan metadata branch,
per-task branches and worktrees, and periodic fetches. That buys simplicity and
costs immediacy, and this document is explicit about where the cost lands.

---

## Contents

- [Quick start](#quick-start) · [Two-clone demo](#the-two-clone-demo)
- [How synchronization works](#how-synchronization-works)
- [Module ownership](#module-ownership)
- [Agent tasks](#agent-tasks) · [Shared sessions](#shared-agent-sessions)
- [Integration and conflicts](#integration-and-conflict-detection)
- [Three architectural states](#observed-desired-and-in-progress)
- [Limits of Git-only collaboration](#what-git-only-synchronization-cannot-do)
- [Design notes](#design-notes)

---

## Quick start

### Initializing a collaborative project

1. Open a project that is a Git repository with a remote your team can reach.
2. **Team → Set up collaboration…**
3. **Initialize collaboration.**

That creates a branch called `collab-state`: an *orphan* branch (no shared
history with your code) holding coordination metadata and nothing else. It is
written without ever being checked out, so initializing cannot touch your
working tree or your uncommitted changes.

If the repository has no remote, you can add one in the dialog. Without a
remote, collaboration works locally but shares nothing — the dialog says so
rather than pretending otherwise.

### How a second developer joins

```bash
git clone <same remote url>
```

Open the clone, then **Team → Set up collaboration… → Join this project.** The
dialog detects that the project is already initialized and offers to join
rather than re-initialize.

Joining only fetches. No existing task, reservation or session is disturbed.

---

## The two-clone demo

Reproducible end to end on one machine, using a local bare repository as the
shared remote. This is exactly what the integration tests do.

```bash
# A shared "server"
mkdir -p /tmp/demo && cd /tmp/demo
git init --bare --initial-branch=main remote.git

# A project to collaborate on
git clone remote.git seed && cd seed
mkdir -p src/auth src/notifications
printf 'export function validateToken(t: string): boolean {\n  return t.length > 0\n}\n' > src/auth/index.ts
printf 'export function notify(m: string): void {\n  console.log(m)\n}\n' > src/notifications/index.ts
printf '{ "name": "demo", "version": "1.0.0" }\n' > package.json
git add -A && git commit -m initial && git push origin main

# Two developers
cd /tmp/demo
git clone remote.git alice
git clone remote.git bob
git -C alice config user.name Alice && git -C alice config user.email alice@example.com
git -C bob   config user.name Bob   && git -C bob   config user.email bob@example.com
```

Then:

1. Open `/tmp/demo/alice` in one Cartograph window and initialize collaboration.
2. Open `/tmp/demo/bob` in a second window and join.
3. In Alice's window: select the auth module → **New task** → "Implement OAuth
   login" → start an agent.
4. In Bob's window: **Sync now.** Alice's task appears, the module shows
   *Coding*, and the node is labelled with her agent.
5. In Bob's window: select the notifications module → **New task** → start a
   second agent. Two agents now edit two worktrees on two branches.
6. Either developer can open the other's session in the **Agents** tab and
   queue an instruction; the host picks it up at its next checkpoint.
7. When an agent finishes, **Review and integrate…** assesses the branch and
   merges it if nothing blocks.

The automated equivalent:

```bash
npm test -- tests/integration/collab-sync.test.ts
```

21 tests drive two real clones through a real bare remote: convergence,
concurrent edits to different and to the same record, shared sessions,
reservation leases, offline queueing and restart recovery.

---

## How synchronization works

### The coordination branch

`collab-state` holds one JSON file per entity kind:

```
collab/project.json        identity, integrated branch, settings
collab/developers.json     participants and last-seen times
collab/tasks.json          tasks and their lifecycle
collab/reservations.json   module leases
collab/sessions.json       agent sessions, activity, instruction queues
collab/operations.json     proposed architecture changes
collab/integrations.json   integration requests and their results
collab/events.json         the shared timeline
```

One file per kind so two clones editing different kinds do not touch the same
object. The branch is read and written through Git's object database — never
checked out — so none of it can disturb your working tree.

### One synchronization pass

1. **Fetch** `collab-state` into a tracking ref.
2. **Merge by value.** Never as text. Entity by entity:
   - different entities → both kept;
   - the same entity → higher `revision` wins, ties broken by timestamp then
     writer id, so every clone picks the same winner;
   - append-only lists (activity, instructions, events, commits) → union by
     id, so nothing is ever overwritten.
3. **Replay the local queue** on top.
4. **Commit and push, without force.**
5. **On rejection** — someone pushed first — fetch, re-merge, retry. Because
   the merge is convergent, retrying is safe and terminates. We never need to
   overwrite their work to publish ours.

Your edits live in a durable queue, and the visible state is derived as
*base + queue*. So a failed push loses nothing, a crash mid-publish replays on
restart, and the same queued edit is never applied twice.

### Freshness is never faked

Reads are local, so the UI works offline. Every surface says how current it is:
the sidebar shows the last successful sync, the Git tab shows the queue depth
and retry count, and when the view is stale, module statuses read **Unknown**
rather than claiming to know what somebody's agent is doing. Default fetch
interval is 10s; **Sync now** forces a pass.

Presence is published on activity checkpoints, not on a timer. Committing every
few seconds to say "still here" would turn the branch into thousands of useless
commits.

---

## Module ownership

Claiming a module records a **lease** — advisory coordination, not a lock:

- other developers see the module as taken, and by whom;
- the lease expires (default 30 minutes), so an abandoned task cannot hold a
  module forever;
- a running agent renews its lease on each heartbeat;
- claiming is conflict-safe: a live reservation held by someone else for a
  different task is not overwritten.

**It is not a security boundary.** An agent runs with your privileges and could
write anywhere. Enforcement is therefore where it can actually be checked:
against the real Git diff when a task is submitted. Changes outside a task's
modules are reported for a human, not silently blocked — and never silently
accepted.

Taking a module someone's agent is actively editing is possible but deliberately
two steps, with the consequence spelled out. Their agent keeps running on their
machine; both sets of changes will have to be reconciled.

---

## Agent tasks

A task has an isolated worktree and branch:

```
project/                        your checkout — agents never touch it
project-agent-worktrees/
  task-101/                     branch agent/task-101
  task-102/                     branch agent/task-102
```

Agents work on **real source files**, not just graph edits. Each is briefed from
the graph before it starts: the module's description and responsibilities, its
public interface, data structures, behavioural contracts, excerpts of the
existing implementation, the interfaces of modules it depends on, **who depends
on it** (so it knows what it must not break), its write scope, the commit it
forked from, and what other agents are doing right now.

An agent may read any file to understand it, and may only write inside its own
modules. The existing tool suite — read, write, move file between modules, move
symbol between files, query the graph, report result — is reused unchanged, so
import rewriting stays compiler-aware.

Worktree creation is idempotent: a restarted agent finds its files where it left
them. Discarding a worktree keeps its branch, so committed work is never lost to
tidying up.

---

## Shared agent sessions

A session belongs to the **project and task**, not to whoever started it.

- Any developer can open it and watch the timeline.
- Any developer can queue an instruction.
- Exactly one machine — the **execution host** — runs the agent, because two
  processes editing one worktree would corrupt it.
- Instructions are applied at **safe checkpoints**, between turns, never
  mid-edit.
- Checkpoints are published, not tokens: "started", "changed 3 files", "tests
  failed", "committed abc123". Streaming tokens through Git would be unreadable
  and enormous.

The host heartbeats while working. If it stops, the session is shown as
**Unknown** rather than *Running* — the UI will not claim an agent is alive
when it cannot verify it.

---

## Integration and conflict detection

Agents never push to the integrated branch. They commit to their task branch and
submit it.

Assessment, in order:

1. **Scope** — the real diff against the task's modules.
2. **Trial merge** — via `merge-tree`, computed in the object database. No
   index, no working tree, so a rejected integration cannot leave anyone's
   checkout conflicted.
3. **Architecture** — what public surface changed, and who depends on it.
4. **Validation** — the project's own `typecheck` / `build` / `test`, only if
   explicitly permitted.
5. **Publish** — re-check the remote ref, merge in a throwaway worktree,
   non-force push, roll back locally if the remote advanced mid-flight.

### The five conflict kinds

| Kind | What it is | Severity |
| --- | --- | --- |
| `file` | Overlapping edits Git cannot reconcile | blocking (fact) |
| `shared_config` | Both sides touched build files or manifests | blocking when two tasks collide |
| `interface` | A public symbol changed that another module calls | blocking if removed, else warning |
| `data_structure` | A shared type's fields changed | warning |
| `contract` | A behavioural guarantee may no longer hold | warning (always a suspicion) |

**Git-level merge success does not mean the result is correct**, and the report
never implies it does. Two branches that merge cleanly still produce a warning
when one changed a signature the other calls:

```
Integration warning (interface)

Authentication.validateToken changed
  Return type changed from boolean to TokenValidationResult.
  Payments calls this and may expect the previous type.

  Affected: Payments
```

`severity` separates proven from suspected throughout. Presenting a suspicion as
a proof teaches people to ignore warnings, which is worse than not warning.

Merely sharing a dependency never blocks parallel work. The graph marks modules
*worth watching* when a neighbour is being changed; it does not call that a
conflict.

---

## Observed, desired and in-progress

Three states stay distinguishable:

- **Observed** — the architecture extracted from the integrated source.
- **Desired** — what developers want it to become. A module added to the graph
  but not yet implemented appears as pending.
- **In progress** — what an individual agent is currently implementing, shown
  per module on the canvas.

Structural graph edits are versioned operations carrying the graph version they
were authored against, so independent edits reconcile and conflicting ones are
flagged. **Layout is not collaboration state**: node positions stay local, so
rearranging the canvas can never cause a merge conflict or a source change.

---

## What Git-only synchronization cannot do

Stated plainly, because each one is architectural rather than a bug:

1. **It is not real-time.** Changes appear on the next fetch — seconds, not
   milliseconds. Every surface shows its last sync time.
2. **An agent cannot be resumed from another machine.** Its worktree is on the
   host. If that machine goes away, the session is marked offline, pending
   instructions are kept for its return, and whatever it committed is still on
   the branch and still integrable. Nobody else can take over the running
   process.
3. **Reservations are advisory.** Git metadata cannot enforce filesystem
   access. Scope is validated against the real diff at integration time.
4. **Two developers can briefly disagree.** Until both have synchronized, each
   sees its own view. The merge is convergent, so they agree once they do.
5. **Simultaneous claims can both appear to succeed.** The loser finds out on
   the next sync. The UI reports it; it does not pretend the race did not
   happen.
6. **Git author identity is attribution, not authentication.** Anyone who can
   push can write metadata. Real access control is your Git host's.
7. **Validation commands are off by default.** Integrating agent-written code
   means running agent-written code. When disabled, validation reports
   `not run` — never `passed`.

The `CollaborationProvider` interface is the seam for fixing (1) and (2): a
WebSocket or server-backed implementation replaces `GitCollaborationProvider`
without the graph editor or the agent orchestration changing.

---

## Design notes

### Where the code lives

| Path | Responsibility |
| --- | --- |
| `shared/collab/` | The data model, per-entity merge, derived module status. Pure data. |
| `core/git/git.ts` | **All** raw Git. Refuses force pushes; never checks out the coordination branch. |
| `core/collab/provider.ts` | `CollaborationProvider` — the transport seam. |
| `core/collab/git-provider.ts` | Fetch, merge, non-force push, retry; durable local queue. |
| `core/collab/tasks.ts` | Per-task worktrees and branches. |
| `core/collab/scope.ts` | Write-scope validation against the real diff. |
| `core/collab/conflicts.ts` | The five conflict kinds, explained via the program graph. |
| `core/collab/integration.ts` | Assess, validate, merge, publish. |
| `core/collab/agent-context.ts` | The graph-aware task brief. |
| `core/collab/agent-session.ts` | Shared sessions, hosts, checkpoints, instructions. |
| `main/services/collab-service.ts` | One live provider per project; the sync timer. |
| `renderer/features/collab/` | All collaboration UI. |

No raw Git in React, and no Git concept in the renderer that the backend has
not already turned into part of the model.

### Reused rather than rebuilt

The analyzer, the program graph, the agent runner and its tools, the
`VirtualWorkspace`, and import rewriting are all used unchanged. The merge
primitive was already there too: `applyOperations` replays an operation log onto
a graph and reports each operation that no longer applies, which is what
`restoreDocument` has always done when reopening a saved architecture.

### Single-player is untouched

Everything here is opt-in. A project without collaboration shows no Team panel,
no extra tabs and no node overlays, and nothing calls into the collaboration
layer. The UI tests run with it off and are unchanged.
