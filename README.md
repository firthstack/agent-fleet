# agent-fleet

A multi-tenant **A2A gateway** with a workflow composition layer: agents
register with it, every message between them passes through it, and workflows
are definitions it owns rather than code inside an agent.

Both ends of every hop speak standard [A2A](https://a2a-protocol.org). The
gateway is an A2A server facing callers and an A2A client facing targets, so
agent authors use off-the-shelf SDKs and there is no proprietary client to
adopt. Agents live in their own repos — the ones this was extracted from are
in [`../john-bot`](../john-bot).

Design docs, which carry the reasoning and the deviations found while
building it:

- [docs/fleet-a2a-gateway.md](docs/fleet-a2a-gateway.md) — transport, tenancy, the callback chain
- [docs/fleet-composition-layer.md](docs/fleet-composition-layer.md) — the workflow state machine

## How a step travels

```
   workflow run ──▶ gateway ──message/send──▶ agent
   (a definition       │                        │
    the gateway        │     (runs for minutes to hours)
    owns)              ▼                        │
        next step ◀──── /a2a/callbacks/{token} ◀┘
```

A step is one `fleet_tasks` row. The gateway owns delivery, backoff retries
and the deadline sweep; the composition layer sits on top and only answers
"what happens next", so it implements no reliability machinery of its own.

## Running it

```bash
npm install
npm run migrate          # DATABASE_URL must be set
npm run dev              # or: npm run build && npm start
```

Open the gateway's root for the **console**. Sign up, connect an agent, write
a workflow against the skills it advertises, start a run, and watch it move —
a list of runs, how long each has sat in its current state, and the timeline
of every step with the gap between them.

The console is a second identity axis, not a second door onto the first one:
people authenticate with a session on `/api/*`, agents with a bearer token on
`/a2a/*`, and neither surface accepts the other's credential.

## Endpoints

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

`/a2a/*` is bearer-only and `/api/*` is session-only, deliberately: one
endpoint accepting both would give the machine surface a CSRF face it never
needed, and would make `caller_agent_id` stop being one kind of thing.

Cross-tenant requests answer `404`, not `403`: a `403` would confirm that some
other tenant owns that agent id.

## Composing agents

`workflows/develop-review-merge.json` is the worked example — implement,
review, revise until the review passes, then ask a human to merge. It is a
**state machine, not a DAG**: the flow loops back from review to revision,
bounded by an iteration limit, which a DAG cannot express.

```bash
curl -X PUT $SITE/a2a/t/$TENANT/workflows/develop-review-merge/1 \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data @workflows/develop-review-merge.json

# sourceRef is what makes a retried request idempotent
curl -X POST $SITE/a2a/t/$TENANT/workflows/develop-review-merge/runs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"payload":{"requirement":"Fix login"},"sourceRef":"issue-9"}'
```

## Tenancy

Isolation is enforced in the routing layer, not by a permission check: the
gateway resolves a target only inside the caller's own tenant, so another
tenant's same-named agent is simply not in the search set. Postgres RLS is the
backstop underneath — `SET LOCAL ROLE` switches into an unprivileged role per
request, because the pool connects as the table owner and RLS does not apply
to such a role.

## Tests

```bash
npm test        # needs a container runtime for the Postgres-backed suites
npm run typecheck
```

`test/fleet/workflowEndToEnd.test.ts` runs the whole thing over real HTTP
against a real Postgres, with agents on the real A2A runtime. The only stubs
are the agents' business logic — the one part a fleet is not responsible for.
