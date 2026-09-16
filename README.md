# agent-fleet

**A multi-tenant [A2A](https://a2a-protocol.org) gateway with a workflow
composition layer.** Agents register with it, every message between them
passes through it, and workflows are definitions the gateway owns rather than
code buried inside an agent.

Both ends of every hop speak standard A2A. The gateway is an A2A server facing
callers and an A2A client facing targets, so agent authors use off-the-shelf
SDKs and there is no proprietary client to adopt. Your agents stay in their own
repos, in whatever language you like; the fleet only needs the URL of something
that publishes an agent card.

The current implementation supports a subset of A2A and has wire-format
compatibility gaps with strict SDKs. See the [integration guide](docs/how-to-integrate-agent.md#current-sdk-compatibility-limits)
before connecting an existing A2A server.

> **First release (0.1.0).** Everything described below works and is covered by
> tests. See [Status](#status) for what is deliberately not here yet.

## Why

Once you have more than one agent, the interesting problems stop being about
any single agent:

- **Something has to own the multi-step flow.** Put "implement → review →
  revise → merge" inside an agent and you have coupled two jobs that change at
  different rates. Here it is a versioned definition, and it is a **state
  machine, not a DAG** — the loop back from review to revision is the thing a
  DAG cannot express.
- **Agent work takes minutes to hours.** So nothing holds a connection. Every
  step is a row with a deadline, a callback token and backoff retries.
- **A burst of submissions is not a burst of work.** Each tenant has a
  concurrency limit; submissions beyond it are accepted and held in `queued`,
  then started in order as slots free up. Agents that share state corrupt each
  other under concurrency rather than merely slowing down.
- **Discovery has to be scoped.** An agent should find the agents it is allowed
  to find, and nothing else. Tenancy is enforced in routing, not by a
  permission check bolted on afterwards.
- **A human needs to see where a run is stuck.** Which is a console, not a log
  file.

## How a step travels

```
   workflow run ──▶ gateway ──message/send──▶ agent
   (a definition       │                        │
    the gateway        │     (runs for minutes to hours)
    owns)              ▼                        │
        next step ◀──── /a2a/callbacks/{token} ◀┘
```

A step is one `fleet_tasks` row. The gateway owns delivery, backoff retries and
the deadline sweep; the composition layer sits on top and only answers "what
happens next", so it implements no reliability machinery of its own.

## Quick start

Requires Node 20+ and a Postgres you can reach.

```bash
npm install
cp .env.example .env     # then fill in DATABASE_URL and the two secrets
npm run migrate
npm run build && npm start   # or: npm run dev
```

Open the gateway's root for the **console**: sign up, connect an agent, write a
workflow against the skills it advertises, start a run, and watch it move — a
list of runs, how long each has sat in its current state, and the timeline of
every step with the gap between them.

Two secrets are not optional. `FLEET_SECRET_KEY` seals the outbound
credentials the gateway presents to your agents, and `BETTER_AUTH_SECRET` signs
console sessions — leaking the latter means anyone can forge any user's
session. `FLEET_PUBLIC_BASE_URL` matters just as much for a different reason:
every callback URL handed to an agent is built from it, so a wrong value means
agents call back to an address that never reaches you.

## Connecting an agent

See [How to integrate an agent](docs/how-to-integrate-agent.md) for the complete
developer guide, an Agent Card example, message formats, and current SDK
compatibility limits. No Fleet-specific SDK is required: use an A2A SDK and
describe each skill's input and output contract in its Agent Card declaration.

An agent needs to do three things: publish an agent card, accept
`message/send`, and call back when the work is finished. Anything that does
that can join a fleet.

From the console, paste the agent's URL. The gateway fetches its card through
an SSRF policy (private ranges, IPv4-in-IPv6, per-hop revalidation, DNS
rebinding), stores the skills it advertises, and issues an inbound token —
**shown once**, because only its hash is kept.

Skills can declare Fleet's optional `inputSchema` field for machine-readable
validation. The console checks a single structured payload before dispatch,
with one issue per offending field, and the workflow editor provides advisory
checks. Agents must still validate incoming messages themselves.

## Composing agents

`workflows/develop-review-merge.json` is the worked example — implement,
review, revise until the review passes, then ask a human to merge. The loop
back from review to revision is bounded by an iteration limit.

Publish and start a run from the console's editor, which validates as you
type, draws the state graph, and warns about anything your actual fleet cannot
serve (a skill no connected agent offers, a payload that does not match one).
Write the definition as JSON or YAML — the editor converts between them, though
a definition is stored as JSON, so YAML comments do not survive a reopen.
Or drive it over the machine surface:

```bash
curl -X PUT $SITE/a2a/t/$TENANT/workflows/develop-review-merge/1 \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data @workflows/develop-review-merge.json

# sourceRef is what makes a retried request idempotent
curl -X POST $SITE/a2a/t/$TENANT/workflows/develop-review-merge/runs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"payload":{"requirement":"Fix login"},"sourceRef":"issue-9"}'
```

A run stays bound to the definition version it started on. Publish changes
with a new version number: publishing the same version again overwrites its
stored definition and can affect active runs.

## Deploying on InstaCloud

The reference deployment runs on [InstaCloud](https://instacloud.com): one
Postgres service and one compute service, wired together by the `insta` CLI.
The `Dockerfile` in this repo builds both halves — the gateway and the console
— into a single image.

```bash
insta login
insta project create agent-fleet          # or run inside an already-linked repo

insta services add postgres agent-db
insta services add compute site

# A provider credential reaches the container only through an explicit
# binding; having a postgres service is not enough.
insta secrets bind DATABASE_URL postgres/agent-db --to compute/site

insta secrets set FLEET_SECRET_KEY   "$(openssl rand -hex 32)"
insta secrets set BETTER_AUTH_SECRET "$(openssl rand -hex 32)"

insta build . --port 8790                 # local pre-flight, no deploy
insta deploy . --group site --port 8790
```

Leave `FLEET_PORT` unset there: the container binds the platform's `PORT`, and
`--port` has to agree with the `EXPOSE` line in the Dockerfile.

Then point the gateway at itself. The URL `insta deploy` prints is what every
callback and agent-facing URL is built from, so it is not optional — an agent
told to call back to the wrong host simply never completes a step:

```bash
insta secrets set FLEET_PUBLIC_BASE_URL https://<the-url-deploy-printed>
insta secrets set FLEET_TRUSTED_ORIGINS https://<the-url-deploy-printed>
insta compute restart site                # a secret change needs a restart
```

Migrations are files under `migrations/`, replayed in order. They travel in the
image, so the deployed service can apply them — but run them as a step of their
own, never as a startup gate:

```bash
insta compute exec site -- npm run migrate
# or, without involving compute at all:
psql "$(insta db url)" -f migrations/0001_fleet_gateway.sql
```

**Branches are the reason this pairs well.** `insta branch create <name>`
forks the database and clones the compute service, so a new workflow
definition can be exercised against a copy of real data on its own URL,
with its own agents connected, without touching production. Nothing InstaCloud
does merges databases, though — only the files in `migrations/` carry schema
forward.

## Endpoints

`/a2a/*` is the machine surface (bearer token). `/api/*` is the console
(session cookie). Neither accepts the other's credential.

| Endpoint | Purpose |
| --- | --- |
| `GET /a2a/t/{tenant}/agents/{id}/.well-known/agent-card.json` | the agent's card, its URL rewritten to the gateway |
| `POST /a2a/t/{tenant}/agents/{id}` | JSON-RPC: `message/send`, `tasks/get` |
| `POST /a2a/callbacks/{token}` | completion callbacks from agents |
| `GET /a2a/t/{tenant}/catalog` | same-tenant agent directory |
| `PUT /a2a/t/{tenant}/workflows/{name}/{version}` | publish a definition (validated on the way in) |
| `GET /a2a/t/{tenant}/workflows` | published definitions |
| `POST /a2a/t/{tenant}/workflows/{name}/runs` | start a run |
| `GET /a2a/t/{tenant}/workflows/runs` | runs, newest first |
| `GET /a2a/t/{tenant}/workflows/runs/{id}` | one run |
| `GET /a2a/t/{tenant}/workflows/runs/{id}/events` | a run's timeline |
| `GET /api/me` | the signed-in user and their tenant |
| `GET /api/agents` | the tenant's agents, resolved from the session |
| `POST /api/agents` | register an agent: fetches its card through the SSRF policy, returns a one-time token |
| `GET /api/agents/{id}` | one agent, with the schema each skill was registered with |
| `PATCH /api/agents/{id}` | change the endpoint (re-fetches the card) or the outbound credential |
| `DELETE /api/agents/{id}` | remove an agent; the tasks it ran stay in the ledger |
| `POST /api/agents/{id}/token` | rotate the inbound token, retiring every earlier one |
| `POST /api/agents/{id}/messages` | send a message as a person — caller `user:{id}`, no callback; the payload is checked against the skill's `inputSchema` before anything is dispatched |
| `GET /api/tasks/{id}` | poll one task, which is how the console reads a result |
| `GET /api/workflows` | published definitions |
| `GET /api/workflows/{name}/{version\|latest}` | one definition, for the editor to open |
| `PUT /api/workflows/{name}/{version}` | publish a version (validated on the way in) |
| `POST /api/workflows/validate` | check without saving — what the editor calls as you type. Returns `issues` (the definition against itself, blocking) and `warnings` (against the tenant's connected agents, advisory) |
| `POST /api/workflows/{name}/runs` | start a run as a person: `created_by` is `user:{id}` |
| `GET /api/runs` | runs, newest first |
| `GET /api/runs/{id}` | one run, with the step it is waiting on |
| `GET /api/runs/{id}/events` | a run's timeline |
| `GET /` and `/app/*` | the console (static; unmatched paths fall back to the SPA shell) |
| `GET /healthz` | liveness |

Splitting the two surfaces is deliberate. One endpoint accepting both a cookie
and a bearer token would give the machine surface a CSRF face it never needed,
and would make `caller_agent_id` stop being one kind of thing.

## Tenancy

Isolation is enforced in the routing layer, not by a permission check: the
gateway resolves a target only inside the caller's own tenant, so another
tenant's same-named agent is simply not in the search set. Postgres RLS is the
backstop underneath — `SET LOCAL ROLE` switches into an unprivileged role per
request, because the pool connects as the table owner and RLS does not apply to
such a role.

Cross-tenant requests answer `404`, not `403`: a `403` would confirm that some
other tenant owns that agent id.

## Tests

```bash
npm test        # needs a container runtime for the Postgres-backed suites
npm run typecheck
```

`test/fleet/workflowEndToEnd.test.ts` runs the whole thing over real HTTP
against a real Postgres, with agents on the real A2A runtime. The only stubs
are the agents' business logic — the one part a fleet is not responsible for.

## Status

Working and tested: agent registration and discovery, the task ledger with
retries and deadline sweeps, the workflow state machine, the console (sign-up,
agents, the workflow editor, run timelines), and payload validation against
each skill's declared schema.

Deliberately not in this release:

- **Visual drag-and-drop composition.** These flows are state machines with
  loops, and a canvas is bad at exactly that shape. The editor is code plus a
  derived graph.
- **Organisations and invitations.** One user is one tenant for now. The
  membership table is already shaped for multiple members, so that change will
  not need a data migration.
- **Billing.** No schema reserved for it.

Known gaps, tracked in the design docs: a run
whose very first dispatch fails *transiently* — the agent was unreachable — is
created with no task behind it to retry, so it stays where it is. A step that
names a skill nothing offers no longer does that: it ends the run.

## License

[Apache 2.0](LICENSE). Copyright 2026 Junwen Feng.

Apache 2.0 rather than MIT for the patent grant: contributors grant a patent
licence with their contribution, and that grant terminates for anyone who
brings a patent suit over the work. For something meant to sit in the middle of
other people's infrastructure, that is worth the extra paragraph.

## Design docs

Developer guide: [How to integrate an agent](docs/how-to-integrate-agent.md).

These describe the current implementation:

- [docs/fleet-a2a-gateway.md](docs/fleet-a2a-gateway.md) — transport, tenancy, the callback chain
- [docs/fleet-composition-layer.md](docs/fleet-composition-layer.md) — the workflow state machine
