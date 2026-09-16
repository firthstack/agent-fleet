# Fleet Composition Layer

This document describes workflow composition in Fleet 0.1.0. Fleet owns workflow definitions, run state, dispatch, and execution history. Agents implement skills in separate repositories and expose them through A2A endpoints; their business logic is not part of this repository.

See the [gateway documentation](fleet-a2a-gateway.md) for transport and tenant isolation, and [How to integrate an agent](how-to-integrate-agent.md) for the agent contract.

## 1. Responsibilities

The composition layer executes declarative state machines. A state can call an external agent skill or evaluate transitions without dispatching work. Conditional transitions support bounded review/revision loops as well as linear flows.

| Component | Responsibility |
|---|---|
| [engine.ts](../src/fleet/workflow/engine.ts) | Evaluate variables, states, transitions, and recovery rules |
| [expr.ts](../src/fleet/workflow/expr.ts) | Parse and evaluate expressions and payload templates |
| [driver.ts](../src/fleet/workflow/driver.ts) | Persist decisions, dispatch steps, and advance runs from completed tasks |
| [dispatcher.ts](../src/fleet/workflow/dispatcher.ts) | Resolve a same-tenant skill provider and send work through the gateway client |
| [workflowStore.ts](../src/fleet/workflow/workflowStore.ts) | Store definitions, runs, events, and queue admission state |
| External agents | Execute skills and report results through Fleet's completion callback |

Fleet does not implement development, review, or merge skills. The sample workflow references skill IDs that independently deployed agents must advertise.

## 2. Definition format

Definitions are JSON objects. The console editor also accepts YAML, converting it to an object before publication. YAML comments and formatting are not stored.

| Field | Purpose |
|---|---|
| `workflow`, `version` | Definition name and version |
| `description` | Optional description |
| `vars` | Initial values and input mappings for variables carried across steps |
| `start` | Ordered transitions selecting the initial state |
| `states` | Named call or decision states |
| `limits` | Values referenced by expressions, such as a maximum iteration count |
| `resume` | Optional rules used by the internal resume operation |
| `dedupeBy` | Declaration present in the format; runtime deduplication currently uses a fixed source key, described in §6 |

### 2.1 Variables and expressions

A variable can read a `from` expression, use an `else` fallback or `init` value when the result is null or missing, and declare `required: true`. Initialization resolves dependencies between variables.

Expressions can read `vars`, `limits`, and available `run` metadata. Initialization can read `input`; transitions following a call can read its `result`. The evaluator supports field access, comparisons, boolean operators, null coalescing, and arithmetic.

Payloads and assignments use `{{expression}}` templates. A value consisting entirely of one template preserves the expression's type, including objects and arrays. Embedded templates produce strings. A variable fallback can use `{ regex: "...", over: "..." }` to extract the first matching substring.

For more complex processing or decisions, call an external skill and use its result.

### 2.2 State execution

A state may declare:

- `status`: the status stored on the run; defaults to the state name.
- `call.skill` and `call.payload`: the skill to invoke and its templated payload.
- `set`: variable assignments.
- `next`: ordered transitions.

A call state pauses for its task result, applies its `set`, and then evaluates `next`. A decision state applies its `set` and evaluates `next` immediately. Assignments are applied in order, so later assignments can read updated variable values.

The first matching transition wins. A transition without `when` is unconditional. Each transition selects one outcome: `goto`, `fail`, or `escalate`; it can also update variables through `set`.

- `goto: completed` finishes successfully.
- `fail: reason` enters `failed` and persists the reason.
- `escalate: reason` enters `needs_human` and persists the reason.

The engine recognizes `completed`, `failed`, `cancelled`, and `needs_human` as terminal names without requiring state declarations. Recognizing `cancelled` does not provide a public cancellation API or cancel a downstream agent task.

### 2.3 Loops and custom decisions

Use a variable counter and an explicit condition against `limits` to bound a loop. Merely declaring a limit does not enforce it.

A `goto` can be a template, allowing an external decision skill to return a state name. Dynamic targets are checked when evaluated; static validation cannot establish which state an agent will return. Include a fallback for missing or invalid decision results.

The engine also guards against excessive transitions without a call using `MAX_SILENT_HOPS = 32`. This protects against decision-only loops; it does not bound loops that dispatch work.

## 3. Workflow examples

### 3.1 Minimal review workflow

This complete definition calls an external `review.pr` skill and either completes or requests human attention:

```yaml
workflow: review-once
version: 1
description: Review a pull request against a requirement.
vars:
  prUrl:
    from: input.prUrl
    required: true
  requirement:
    from: input.requirement
    required: true
start:
  - goto: reviewing
states:
  reviewing:
    status: reviewing
    call:
      skill: review.pr
      payload:
        prUrl: "{{vars.prUrl}}"
        requirement: "{{vars.requirement}}"
    next:
      - when: "result.ok && result.verdict == 'approved'"
        goto: completed
      - escalate: review_needs_attention
```

Register exactly one agent offering `review.pr` in the tenant. Its message contract must accept the two payload fields and return `ok` and `verdict`. Fleet sends the resolved payload as one A2A data part.

### 3.2 Develop, review, revise, and request merge

The complete example is [workflows/develop-review-merge.json](../workflows/develop-review-merge.json). That file is the reference definition; the skills it calls belong to external agents.

| Skill | Role in the example |
|---|---|
| `develop.issue` | Implement a requirement and return a PR URL |
| `review.pr` | Review the PR and return a verdict and findings |
| `develop.revise` | Revise an existing PR using review findings |
| `pr.merge` | Request a merge subject to external approval |

The definition accepts a requirement, an existing PR URL, or both. If neither is supplied, it fails with `no_requirement`. With an existing PR, it starts at review; otherwise it starts at development. An optional issue URL can be supplied or extracted from the requirement.

An approved review leads to `requesting_merge`. A comment verdict requests human attention. A request for changes increments the iteration counter and either dispatches revision or escalates at `limits.maxIterations`, currently 7. Successful revision returns to review.

`requesting_merge` has the display status `merge_requested` and sends `workflowRunId` as a string. Completion depends on the external skill's result; Fleet itself does not merge a PR or implement the approval channel.

## 4. Validation and editing

`validateDefinition` checks required definition fields, transition outcomes, condition syntax, static target names, and fallback branches. These checks run before publication.

The console's `POST /api/workflows/validate` returns:

- `issues`: definition errors that block publication.
- `warnings`: advisory checks against the tenant's registered agents and their skill input schemas.

Payload checks skip values whose types depend on runtime templates, while still checking known fields and literal values. Warnings do not require agents to be connected before a workflow can be published. Runtime dispatch still checks skill availability.

The editor accepts JSON or YAML, shows a derived state diagram including loops, and preserves the current text if format conversion cannot parse it. Published definitions are stored as JSON; reopening does not restore YAML comments.

## 5. Execution and persistence

### 5.1 Advancing a run

1. The driver resolves the requested definition version, initializes variables, and evaluates `start`.
2. An admitted run records its next state before dispatch, making in-flight work visible.
3. The dispatcher resolves the skill within the tenant, creates a task linked to the run, and sends its payload to the agent.
4. The agent reports completion to Fleet's callback endpoint.
5. The workflow worker claims the completed task, evaluates the next decision, persists events and variables, and dispatches another step or finishes the run.

Each step uses `fleet_tasks` and the gateway's deadline and callback machinery. Workflow-owned tasks are claimed by the driver; ordinary caller webhook notifications use a separate queue predicate.

The driver unwraps the stored callback result for workflow expressions. Timeouts and failed tasks without a usable result are represented as `ok: false` with an error so transitions can handle them.

### 5.2 Stored state

| Table or field | Purpose |
|---|---|
| `fleet_workflows` | Tenant-scoped name, version, and definition; `definition` uses PostgreSQL `json` |
| `fleet_workflow_runs` | Bound `workflow_id`, current `state`, `status`, `reason`, variables, source identity, and creator |
| `fleet_workflow_run_events` | Ordered execution history |
| `fleet_tasks.workflow_run_id` | Associates a dispatched task with a run |
| `fleet_tasks.workflow_from_state` | State whose completion drives the next transition |
| `fleet_workflow_runs.awaiting_task_id` | Task the run currently awaits |
| `fleet_workflow_runs.admitted_at` | Admission timestamp; null while waiting for capacity |
| `fleet_workflow_runs.input_payload` | Original input used to start a queued run |

The driver advances from the task's recorded state. The run may already show the next attempted state if dispatch failed, so its visible state alone is not sufficient retry provenance.

When a run awaits a different task ID, stale completions are ignored. Updates that omit `awaiting_task_id` preserve it; an explicit null clears it. This supports retrying advancement after a dispatch error.

The engine reports the full path through decision states, and the driver records those states in the timeline even when they dispatch no work.

## 6. Versioning, source identity, and admission

### 6.1 Definition versions

A run references a specific `fleet_workflows` row. Starting without a requested version selects the highest published version.

**Publish changes with a new version number.** The current store upserts on `(tenant_id, name, version)`: publishing the same version again replaces its definition. Since active runs read that row when advancing, overwriting a version can affect them. Version immutability is not enforced.

### 6.2 Duplicate submissions

Runtime deduplication uses `(tenant_id, source_type, source_ref)`. Console starts use source type `console`; machine starts use `a2a`. Reusing a source reference in the same tenant and source type returns the existing run, even across workflow names.

Supply a stable `sourceRef` when retrying one logical submission and a new value for new work. If omitted, the API generates a reference. The `dedupeBy` field does not currently configure arbitrary deduplication expressions.

### 6.3 Per-tenant admission

`FLEET_MAX_CONCURRENT_RUNS_PER_TENANT` defaults to 10. Excess submissions create visible queued runs with no admission timestamp and dispatch no work until capacity becomes available.

Admission counting and writes run in a transaction serialized with a tenant-scoped advisory lock. Queued runs start in submission order. The worker drains queues after advancing completed steps so newly released capacity can be reused in the same tick.

Queued starts use the original `input_payload` instead of reapplying initial transitions to already initialized variables. Admitted runs still marked `queued` can be reclaimed after a crash between admission and dispatch.

This is a per-tenant run limit, not a per-agent execution lock. External agents must handle their own concurrency requirements.

## 7. Failures and current limits

| Condition | Current behavior |
|---|---|
| No agent offers a requested skill | Fail the run with `no_agent` and a reason naming the skill |
| More than one agent offers the skill | Fail with `ambiguous_agent`; the workflow format has no agent selector |
| Transient dispatch failure while advancing a completed step | The driving task can be retried through the workflow worker's backoff queue |
| Transient failure on the first dispatch | Can leave a run without a task to drive retry; automatic recovery is incomplete |
| Agent never reports completion | The task deadline expires; the workflow receives a failed step result |

Steps have a six-hour timeout by default. Retrying advancement does not provide exactly-once execution of external side effects; agents should make operations idempotent where possible.

The engine and driver implement `resume` rules: the first matching rule chooses a recovery state; no match means the run is not resumable through that operation. There is currently no public resume endpoint or console resume action. Likewise, `needs_human` records an escalation state but does not itself send an approval request.

## 8. APIs and verification

Use the console to publish definitions, start runs, and inspect timelines. Machine callers use tenant-scoped routes with their Fleet bearer token:

| Operation | Machine route |
|---|---|
| Publish a version | `PUT /a2a/t/{tenant}/workflows/{name}/{version}` |
| List definitions | `GET /a2a/t/{tenant}/workflows` |
| Start a run | `POST /a2a/t/{tenant}/workflows/{name}/runs` |
| List runs | `GET /a2a/t/{tenant}/workflows/runs` |
| Read a run | `GET /a2a/t/{tenant}/workflows/runs/{id}` |
| Read its timeline | `GET /a2a/t/{tenant}/workflows/runs/{id}/events` |

See the [README](../README.md#composing-agents) for publish/start commands and console routes.

[test/fleet/workflowEndToEnd.test.ts](../test/fleet/workflowEndToEnd.test.ts) exercises the driver over real HTTP and Postgres with the bundled A2A runtime. Agent business logic is stubbed; deployed agent implementations remain outside this repository. Engine, driver, store, and console tests cover expressions, transitions, admission, dispatch errors, validation, and timelines.
