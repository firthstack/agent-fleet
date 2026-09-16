# How to integrate an agent

You do not need a Fleet-specific SDK. Build your agent with an A2A SDK in your preferred language, publish an Agent Card, and connect its endpoint in Fleet. Your agent can stay in its own repository and run on your own infrastructure.

The card is your integration contract. Follow A2A's Agent Card format and **include the accepted message format in each skill's declaration**: fields, types, required values, examples, and the result your agent returns. This gives developers the information needed to configure Fleet to send the right messages.

Fleet 0.1.0 uses JSON-RPC `message/send` and asynchronous completion callbacks. It has compatibility gaps with strict A2A SDKs, described below; an unmodified SDK server is not guaranteed to work. No Fleet package is required, but your HTTP boundary may need to accommodate the current wire format.

## 1. Expose an A2A endpoint

Use your language's A2A SDK to serve an Agent Card and a JSON-RPC endpoint. The [A2A 0.3.0 specification](https://a2a-protocol.org/v0.3.0/specification/) documents the card, skills, messages, tasks, and push notifications used as the reference for this guide. Match your SDK's protocol version and transport to the deployment you are integrating with.

For the current Fleet implementation:

- Publish a publicly readable card at `https://your-agent.example.com/.well-known/agent-card.json`. Fleet fetches this path at the **origin root**, even if your JSON-RPC endpoint has a path such as `/a2a`.
- Provide an HTTPS JSON-RPC endpoint accepting `message/send`. Fleet sends requests to the **endpoint URL entered at registration**, so make it agree with your card's `url`.
- Return a task ID promptly, then report completion using the supplied callback configuration. Implement `tasks/get` in your agent for task inspection.
- Make the endpoint reachable from Fleet. The default registration policy rejects private, loopback, and link-local addresses. For local development, expose the agent through an HTTPS tunnel such as `cloudflared` or `ngrok`.

The card fetch does not include the outbound credential configured in Fleet. Keep the public card accessible while authenticating work requests separately.

## 2. Declare skills and their message formats

Here is a standard Agent Card example for a review agent. Its description includes the full application message contract rather than only “reviews pull requests”:

```json
{
  "protocolVersion": "0.3.0",
  "name": "Pull Request Reviewer",
  "description": "Reviews a pull request against a supplied requirement.",
  "version": "1.0.0",
  "url": "https://review.example.com/a2a",
  "preferredTransport": "JSONRPC",
  "capabilities": {
    "streaming": false,
    "pushNotifications": true
  },
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json"],
  "securitySchemes": {
    "agentBearer": {
      "type": "http",
      "scheme": "bearer"
    }
  },
  "security": [{ "agentBearer": [] }],
  "skills": [
    {
      "id": "review.pr",
      "name": "Review a pull request",
      "description": "Select this skill with params.metadata.skillId = review.pr. Send one data part whose data is an object with required prUrl (string, an HTTPS GitHub pull-request URL) and requirement (non-empty string). No other fields are accepted. Example input: {\"prUrl\":\"https://github.com/acme/app/pull/42\",\"requirement\":\"Fix login\"}. The result is an object with ok (boolean), verdict (approved, request_changes, or comment), reviewUrl (string or null), and findings (array of objects with title and detail strings). Example result: {\"ok\":true,\"verdict\":\"approved\",\"reviewUrl\":null,\"findings\":[]}.",
      "tags": ["code-review", "github"],
      "examples": [
        "{\"prUrl\":\"https://github.com/acme/app/pull/42\",\"requirement\":\"Fix login\"}"
      ],
      "inputModes": ["application/json"],
      "outputModes": ["application/json"]
    }
  ]
}
```

For each skill, document:

- Its stable `id` and what work it performs.
- Whether input is text or structured data, and how message parts are arranged.
- Field names, types, required and optional fields, defaults, allowed values, and constraints.
- A valid input example and the result fields a workflow may reference.
- How failures are reported and whether the work has side effects.

Keep essential format instructions in `skills[].description`. Fleet currently normalizes skill records to `id`, `name`, `description`, and optional `inputSchema`; it does not retain skill-level `examples`, `tags`, or input/output modes in the registered skill record.

Descriptions document the contract; Fleet does **not** infer a schema, generate a payload, or translate arbitrary text into the declared structure. A developer configures the payload in the console or workflow.

### Optional machine-readable validation

Fleet recognizes `skills[].inputSchema` as an optional **Fleet-specific field**, not a standard A2A 0.3.0 AgentSkill field. Add the following property to the skill above if you want console validation and workflow-editor checks:

```json
{
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["prUrl", "requirement"],
    "properties": {
      "prUrl": {
        "type": "string",
        "pattern": "^https://github[.]com/[^/]+/[^/]+/pull/[0-9]+$",
        "description": "The GitHub pull request to review."
      },
      "requirement": {
        "type": "string",
        "minLength": 1,
        "description": "The requirement against which to review the changes."
      }
    }
  }
}
```

This schema describes the **data payload**, not the JSON-RPC envelope. If your SDK strips unknown fields, include it in the served card JSON yourself, or omit it and keep the contract in the standard description.

The console validates a single data part before creating a task. Workflow-editor checks are advisory and skip values that depend on runtime templates. These checks are not universal validation of all A2A traffic: your agent must validate inputs too.

## 3. Handle Fleet's messages and completion callbacks

Fleet sends the workflow's resolved `call.payload` as one data part. The following is the **current Fleet outbound request shape**, not a fully compliant A2A message example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "kind": "data",
          "data": {
            "prUrl": "https://github.com/acme/app/pull/42",
            "requirement": "Fix login"
          }
        }
      ]
    },
    "configuration": {
      "pushNotificationConfig": {
        "url": "https://fleet.example.com/a2a/callbacks/EXAMPLE_TASK_TOKEN",
        "token": "EXAMPLE_TASK_TOKEN"
      }
    },
    "metadata": {
      "skillId": "review.pr",
      "deadlineAt": "2030-01-01T18:00:00.000Z",
      "contextId": "example-upstream-task-id"
    }
  }
}
```

`params.metadata.skillId` selects the skill. `deadlineAt` is the shared deadline; do not start expired work, and arrange to stop work at the deadline. `contextId`, when present, is Fleet's correlation value. These metadata keys are Fleet's application conventions.

Return a task response immediately, echoing the request ID:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "kind": "task",
    "id": "review-task-123",
    "contextId": "review-context-123",
    "status": { "state": "submitted" }
  }
}
```

Save the task ID and supplied push configuration. Once finished, POST the following **Fleet completion body** to the exact supplied callback URL:

```json
{
  "taskId": "review-task-123",
  "status": { "state": "completed" },
  "result": {
    "ok": true,
    "verdict": "approved",
    "reviewUrl": "https://github.com/acme/app/pull/42#pullrequestreview-123",
    "findings": []
  }
}
```

Use `Content-Type: application/json`. Fleet's bundled runtime also sends `Authorization: Bearer <pushNotificationConfig.token>`; the gateway currently resolves the token in the URL path. Keep that URL private. For failure, use `status.state: "failed"` and a top-level `error` string. Report your agent's task ID, not Fleet's upstream ID.

Send only the final completion to this callback: the current handler treats incoming callbacks as completion and consumes the token. Retry transient delivery failures with backoff, including an early callback that arrives before Fleet has recorded your task ID. After successful completion, the token is invalidated; a duplicate delivery may return 404. Keep task execution idempotent where possible.

### Current SDK compatibility limits

An A2A SDK provides the protocol implementation; it does not erase these Fleet 0.1.0 differences:

- Fleet's outbound message omits A2A's `messageId` and `kind: "message"`. Strict SDK request validation may reject it. An integration boundary must supply these before SDK validation, or the gateway must gain full standard-envelope support.
- Fleet requires a Task response containing `result.id`. It does not handle an immediate Message response or consume results from an immediately completed Task. Complete the callback even for fast work.
- The callback handler reads top-level `result` and `error`, not Task `artifacts`. Configure completion delivery to match the body above; a standard Task push alone will not pass its artifact data into workflow expressions.
- Fleet forwards JSON-RPC `message/send` and serves `tasks/get`. Streaming, gRPC, REST transport negotiation, `tasks/cancel`, and separate push-configuration RPCs are not implemented by the gateway.

These are implementation limits, not requirements of A2A. The relevant implementations are [the outbound client](../src/fleet/site/a2aClient.ts), [callback handler](../src/fleet/site/callbacks.ts), and [bundled example runtime](../src/fleet/runtime/a2aServer.ts). You do not need to import that runtime or any Fleet code into your agent.

## 4. Register in Fleet

1. Sign in to the Fleet console and open **Agents → Connect an agent**.
2. Choose an agent ID: 3–64 lowercase letters, digits, or hyphens, beginning and ending with a letter or digit. It must be unique within your tenant; it is separate from the Agent Card.
3. Enter your JSON-RPC endpoint, such as `https://review.example.com/a2a`, and an optional display name.
4. Enter the **outbound bearer token** your agent expects from Fleet. The console currently supports bearer credentials; declaring security in the card alone does not configure a credential.
5. Connect. Fleet fetches and validates the card, stores the skills, and shows an **inbound Fleet token once**. Save it securely if the agent needs to call Fleet's machine API; rotate it if lost.

The outbound token authenticates **Fleet → your agent**. The generated inbound token authenticates **your agent → Fleet's machine API**. Completion uses the separate **per-task callback token** from the request; do not substitute the registration token.

Registration confirms card reachability, not that your message handler or outbound credential works. Test a real message next.

## 5. Send a message and use the skill in a workflow

Open the agent's detail page, select `review.pr`, choose structured JSON input, and send:

```json
{
  "prUrl": "https://github.com/acme/app/pull/42",
  "requirement": "Fix login"
}
```

Verify that the agent receives the declared fields, returns a task ID, and sends a completion callback. The console should show the final result.

For a workflow, use a state such as:

```yaml
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

This is a state fragment, not a complete workflow. Define `vars.prUrl` and `vars.requirement` in the surrounding definition. Currently, exactly one agent in the tenant must offer the workflow's skill: multiple matches fail with `ambiguous_agent`, and the workflow format does not yet expose an agent selector. Use distinct skill IDs if agents need separate workflow routing. The callback's `result` becomes the result available to these transition expressions.

Agents that also call other agents can discover them through `GET /a2a/t/{tenant}/catalog?skill=review.pr` with their inbound Fleet bearer token. Choose a returned agent explicitly and call its gateway URL with an A2A client. Communication stays within the caller's tenant.

For a complete workflow example, see [develop-review-merge.json](../workflows/develop-review-merge.json). For gateway setup and endpoint reference, see the [README](../README.md).
