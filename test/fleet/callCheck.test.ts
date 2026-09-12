import { describe, expect, it } from "vitest";
import { checkCallPayloads, skillIndex } from "../../src/fleet/workflow/callCheck.js";
import type { WorkflowDefinition } from "../../src/fleet/workflow/engine.js";

/**
 * Checking a definition against the fleet it will run on, rather than against
 * itself. Both failures this catches — nothing offers the skill, the payload
 * is not what the skill accepts — are otherwise met hours into a real run.
 */

const agents = [
  {
    agentId: "dev-agent",
    card: {
      skills: [
        {
          id: "develop.issue",
          inputSchema: {
            type: "object",
            properties: {
              requirement: { type: "string" },
              iteration: { type: "number" },
            },
            required: ["requirement", "iteration"],
            additionalProperties: false,
          },
        },
      ],
    },
  },
  { agentId: "review-agent", card: { skills: [{ id: "review.pr" }] } },
];

function definition(call: unknown): WorkflowDefinition {
  return {
    workflow: "w",
    version: 1,
    start: [{ goto: "working" }],
    states: { working: { call, next: [{ goto: "completed" }] } },
  } as unknown as WorkflowDefinition;
}

describe("skillIndex", () => {
  it("collects every agent offering a skill", () => {
    const index = skillIndex([
      ...agents,
      { agentId: "dev-agent-2", card: { skills: [{ id: "develop.issue" }] } },
    ]);
    expect(index.get("develop.issue")?.agentIds).toEqual(["dev-agent", "dev-agent-2"]);
    // The schema comes from the first card that declared one.
    expect(index.get("develop.issue")?.inputSchema).toBeDefined();
  });

  it("survives a card with no skills at all", () => {
    expect(skillIndex([{ agentId: "bare", card: {} }]).size).toBe(0);
  });
});

describe("checkCallPayloads", () => {
  const index = skillIndex(agents);

  it("is quiet when the payload matches", () => {
    const def = definition({
      skill: "develop.issue",
      payload: { requirement: "{{vars.requirement}}", iteration: "{{vars.iteration}}" },
    });
    expect(checkCallPayloads(def, index)).toEqual([]);
  });

  it("says when nothing in the tenant offers the skill", () => {
    const def = definition({ skill: "deploy.prod", payload: {} });
    expect(checkCallPayloads(def, index)).toEqual([
      {
        path: "states.working.call.skill",
        // The same refusal the dispatcher makes at run time — except there,
        // the run is already created and then strands.
        message: "no agent in this tenant offers deploy.prod",
      },
    ]);
  });

  it("says when several agents offer it, because dispatch will refuse to pick", () => {
    const two = skillIndex([
      ...agents,
      { agentId: "dev-agent-2", card: { skills: [{ id: "develop.issue" }] } },
    ]);
    const def = definition({
      skill: "develop.issue",
      payload: { requirement: "{{vars.r}}", iteration: 0 },
    });
    const warnings = checkCallPayloads(def, two);
    expect(warnings[0].path).toBe("states.working.call.skill");
    expect(warnings[0].message).toContain("dev-agent, dev-agent-2");
  });

  it("points at the offending key inside the payload", () => {
    const def = definition({
      skill: "develop.issue",
      payload: { requirement: "{{vars.requirement}}", iterations: 3 },
    });
    expect(checkCallPayloads(def, index)).toEqual(
      expect.arrayContaining([
        {
          path: "states.working.call.payload.iteration",
          message: "required, but missing",
        },
        {
          path: "states.working.call.payload.iterations",
          message: "not declared by this skill",
        },
      ]),
    );
  });

  it("says nothing about a value that is only known at dispatch", () => {
    // `{{vars.iteration}}` is a number at run time and a string on the page;
    // complaining about its type here would be noise nobody can act on.
    const def = definition({
      skill: "develop.issue",
      payload: { requirement: "{{vars.requirement}}", iteration: "{{vars.iteration}}" },
    });
    expect(checkCallPayloads(def, index)).toEqual([]);
  });

  it("checks a literal value written straight into the payload", () => {
    const def = definition({
      skill: "develop.issue",
      payload: { requirement: "{{vars.requirement}}", iteration: "first" },
    });
    expect(checkCallPayloads(def, index)).toEqual([
      { path: "states.working.call.payload.iteration", message: "must be number" },
    ]);
  });

  it("is quiet about a skill that declares no schema", () => {
    const def = definition({ skill: "review.pr", payload: { anything: 1 } });
    expect(checkCallPayloads(def, index)).toEqual([]);
  });

  it("ignores states that dispatch nothing", () => {
    const def = {
      workflow: "w",
      version: 1,
      start: [{ goto: "pr_opened" }],
      states: { pr_opened: { next: [{ goto: "completed" }] } },
    } as unknown as WorkflowDefinition;
    expect(checkCallPayloads(def, index)).toEqual([]);
  });
});
