import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advance,
  requiredSkills,
  resumeRun,
  startRun,
  validateDefinition,
  type Decision,
  type RunSnapshot,
  type WorkflowDefinition,
} from "../../src/fleet/workflow/engine.js";

/**
 * Drives the real develop → review → merge definition through the engine.
 * This is the falsification exercise from the design doc: if the format
 * cannot reproduce the behaviour the hand-written orchestration had, the
 * format is wrong.
 */
const def = JSON.parse(
  readFileSync("workflows/develop-review-merge.json", "utf8"),
) as WorkflowDefinition;

const PR = "https://github.com/o/r/pull/7";
const PR2 = "https://github.com/o/r/pull/8";
const ISSUE = "https://github.com/o/r/issues/9";

function snapshot(decision: Decision, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: 42,
    state: decision.kind === "call" ? decision.state : decision.state,
    status: decision.status,
    vars: decision.vars,
    ...overrides,
  };
}

function expectCall(decision: Decision, skillId: string) {
  if (decision.kind !== "call") {
    throw new Error(`expected a call to ${skillId}, got terminal ${decision.state}`);
  }
  expect(decision.skillId).toBe(skillId);
  return decision;
}

describe("definition is statically sound", () => {
  it("passes validation with no issues", () => {
    expect(validateDefinition(def)).toEqual([]);
  });

  it("declares exactly the four skills the fleet provides", () => {
    // The gateway preflights these, replacing the hand-written capability
    // checks the old orchestration ran at each entry point.
    expect(requiredSkills(def)).toEqual([
      "develop.issue",
      "develop.revise",
      "pr.merge",
      "review.pr",
    ]);
  });
});

describe("entry points", () => {
  it("starts from development when given a requirement", () => {
    const first = expectCall(
      startRun(def, { requirement: `handle issue: ${ISSUE}` }),
      "develop.issue",
    );
    expect(first.state).toBe("developing");
    expect(first.payload).toEqual({
      requirement: `handle issue: ${ISSUE}`,
      // Pulled out of the requirement text — the old extractGitHubIssueUrl.
      issueUrl: ISSUE,
      iteration: 0,
    });
  });

  it("prefers an explicit issueUrl over the one in the text", () => {
    const first = expectCall(
      startRun(def, {
        requirement: `handle issue: ${ISSUE}`,
        issueUrl: "https://github.com/o/r/issues/99",
      }),
      "develop.issue",
    );
    expect(first.payload.issueUrl).toBe("https://github.com/o/r/issues/99");
  });

  it("derives issueUrl however the storage layer ordered the keys", () => {
    // Postgres `jsonb` reorders object keys by length then bytewise, which put
    // `issueUrl` ahead of the `requirement` it is extracted from. Declaration
    // order is not something the engine gets to rely on.
    const reordered: WorkflowDefinition = {
      ...def,
      vars: Object.fromEntries(
        Object.entries(def.vars ?? {}).sort(
          ([a], [b]) => a.length - b.length || a.localeCompare(b),
        ),
      ),
    };
    expect(Object.keys(reordered.vars ?? {})[0]).not.toBe("requirement");

    const first = expectCall(
      startRun(reordered, { requirement: `handle issue: ${ISSUE}` }),
      "develop.issue",
    );
    expect(first.payload.issueUrl).toBe(ISSUE);
  });

  it("leaves issueUrl null when the requirement mentions none", () => {
    const first = expectCall(
      startRun(def, { requirement: "just make the tests pass" }),
      "develop.issue",
    );
    expect(first.payload.issueUrl).toBeNull();
  });

  it("skips development and reviews straight away when given a PR", () => {
    // The old workflow.review_pr entry point, which took prUrl alone and
    // synthesised the requirement rather than demanding one.
    const first = expectCall(startRun(def, { prUrl: PR }), "review.pr");
    expect(first.state).toBe("reviewing");
    expect(first.payload.prUrl).toBe(PR);
    expect(first.payload.requirement).toBe(`Review submitted PR ${PR}`);
  });

  it("still takes an explicit requirement alongside the PR", () => {
    const first = expectCall(
      startRun(def, { requirement: "tighten the retry window", prUrl: PR }),
      "review.pr",
    );
    expect(first.payload.requirement).toBe("tighten the retry window");
  });

  it("refuses a dispatch with neither a requirement nor a PR", () => {
    // The synthesised requirement must not paper over an empty request:
    // without the start guard this would run develop.issue on the string
    // "Review submitted PR ".
    const decision = startRun(def, {});
    expect(decision).toMatchObject({
      kind: "terminal",
      state: "failed",
      reason: "no_requirement",
    });
  });
});

describe("happy path", () => {
  it("runs develop → review → merge to completion", () => {
    const developing = expectCall(
      startRun(def, { requirement: "Add fleet composition" }),
      "develop.issue",
    );

    // Development opens a PR; the engine walks through pr_opened without a
    // dispatch and lands on the review call.
    const reviewing = expectCall(
      advance(def, snapshot(developing), { ok: true, prUrl: PR }),
      "review.pr",
    );
    expect(reviewing.state).toBe("reviewing");
    expect(reviewing.payload.prUrl).toBe(PR);

    const merging = expectCall(
      advance(def, snapshot(reviewing), {
        ok: true,
        verdict: "approved",
        reviewUrl: "https://github.com/review/1",
      }),
      "pr.merge",
    );
    // The status is recorded before the call, so an observer can see that we
    // are waiting on Slack rather than only learning afterwards.
    expect(merging.status).toBe("merge_requested");
    expect(merging.payload).toMatchObject({
      prUrl: PR,
      reviewUrl: "https://github.com/review/1",
      workflowRunId: "42",
      reason: "codex review passed; external approval required before merge",
    });

    const done = advance(def, snapshot(merging), { ok: true, slackMessageTs: "1.2" });
    expect(done).toMatchObject({ kind: "terminal", state: "completed" });
  });
});

describe("the revision loop", () => {
  function toFirstReview() {
    const developing = expectCall(
      startRun(def, { requirement: "Add fleet composition" }),
      "develop.issue",
    );
    return expectCall(
      advance(def, snapshot(developing), { ok: true, prUrl: PR }),
      "review.pr",
    );
  }

  it("sends the findings to develop.revise and bumps the iteration", () => {
    const reviewing = toFirstReview();
    const findings = [{ title: "Missing auth", detail: "Endpoint is public" }];

    const revising = expectCall(
      advance(def, snapshot(reviewing), {
        ok: true,
        verdict: "request_changes",
        findings,
        reviewUrl: "https://github.com/review/1",
      }),
      "develop.revise",
    );

    expect(revising.payload).toEqual({
      requirement: "Add fleet composition",
      priorPrUrl: PR,
      iteration: 1,
      // Must arrive as an array, not as "[object Object]".
      reviewFindings: findings,
    });
  });

  it("closes the loop back to review with the new PR", () => {
    const reviewing = toFirstReview();
    const revising = expectCall(
      advance(def, snapshot(reviewing), {
        ok: true,
        verdict: "request_changes",
        findings: [],
      }),
      "develop.revise",
    );

    const secondReview = expectCall(
      advance(def, snapshot(revising), { ok: true, prUrl: PR2 }),
      "review.pr",
    );
    expect(secondReview.state).toBe("reviewing");
    expect(secondReview.payload).toMatchObject({ prUrl: PR2, iteration: 1 });
  });

  it("escalates once the iteration budget is spent", () => {
    let current: Decision = toFirstReview();
    let rounds = 0;

    // Keep asking for changes; the engine must stop on its own.
    for (;;) {
      const next = advance(def, snapshot(current), {
        ok: true,
        verdict: "request_changes",
        findings: [],
      });
      if (next.kind === "terminal") {
        expect(next).toMatchObject({
          state: "needs_human",
          reason: "max_iterations_exceeded",
        });
        break;
      }
      expectCall(next, "develop.revise");
      current = advance(def, snapshot(next), { ok: true, prUrl: PR2 });
      expectCall(current, "review.pr");
      rounds += 1;
      if (rounds > 20) throw new Error("the iteration guard never fired");
    }

    // limits.maxIterations is 7 and the counter starts at 0, so the seventh
    // request for changes is the one that gives up.
    expect(rounds).toBe(6);
  });

  it("preserves the review URL across a round that does not report one", () => {
    const reviewing = toFirstReview();
    const revising = expectCall(
      advance(def, snapshot(reviewing), {
        ok: true,
        verdict: "request_changes",
        findings: [],
        reviewUrl: "https://github.com/review/1",
      }),
      "develop.revise",
    );
    const second = expectCall(
      advance(def, snapshot(revising), { ok: true, prUrl: PR2 }),
      "review.pr",
    );
    const merging = expectCall(
      advance(def, snapshot(second), { ok: true, verdict: "approved" }),
      "pr.merge",
    );
    // The second review returned no reviewUrl; the first one must survive.
    expect(merging.payload.reviewUrl).toBe("https://github.com/review/1");
  });
});

describe("failure and escalation branches", () => {
  function developing() {
    return expectCall(
      startRun(def, { requirement: "Add fleet composition" }),
      "develop.issue",
    );
  }

  it("fails when development reports no PR", () => {
    expect(advance(def, snapshot(developing()), { ok: true })).toMatchObject({
      kind: "terminal",
      state: "failed",
      reason: "develop_failed",
    });
    expect(advance(def, snapshot(developing()), { ok: false })).toMatchObject({
      reason: "develop_failed",
    });
  });

  it("fails when review returns no verdict", () => {
    const reviewing = expectCall(
      advance(def, snapshot(developing()), { ok: true, prUrl: PR }),
      "review.pr",
    );
    expect(advance(def, snapshot(reviewing), { ok: true })).toMatchObject({
      state: "failed",
      reason: "review_failed",
    });
  });

  it("escalates a review that only left comments", () => {
    const reviewing = expectCall(
      advance(def, snapshot(developing()), { ok: true, prUrl: PR }),
      "review.pr",
    );
    expect(
      advance(def, snapshot(reviewing), { ok: true, verdict: "comment" }),
    ).toMatchObject({ state: "needs_human", reason: "review_comment" });
  });

  it("fails when the merge request could not be posted", () => {
    const reviewing = expectCall(
      advance(def, snapshot(developing()), { ok: true, prUrl: PR }),
      "review.pr",
    );
    const merging = expectCall(
      advance(def, snapshot(reviewing), { ok: true, verdict: "approved" }),
      "pr.merge",
    );
    expect(advance(def, snapshot(merging), { ok: false })).toMatchObject({
      state: "failed",
      reason: "merge_request_failed",
    });
  });

  it("falls through to review_failed on an unrecognised verdict", () => {
    const reviewing = expectCall(
      advance(def, snapshot(developing()), { ok: true, prUrl: PR }),
      "review.pr",
    );
    // A newer review agent inventing a verdict must not wedge the run.
    expect(
      advance(def, snapshot(reviewing), { ok: true, verdict: "needs_discussion" }),
    ).toMatchObject({ state: "failed", reason: "review_failed" });
  });
});

describe("resume", () => {
  const vars = {
    requirement: "Add fleet composition",
    issueUrl: null,
    prUrl: PR,
    reviewUrl: null,
    iteration: 1,
    findings: [],
  };

  it("picks up an interrupted review", () => {
    const decision = resumeRun(def, {
      id: 42,
      state: "reviewing",
      status: "reviewing",
      vars,
    });
    expectCall(decision as Decision, "review.pr");
  });

  it("restarts a development that failed before opening a PR", () => {
    const decision = resumeRun(def, {
      id: 42,
      state: "failed",
      status: "failed",
      reason: "develop_failed",
      vars: { ...vars, prUrl: null },
    });
    expectCall(decision as Decision, "develop.issue");
  });

  it("reports a run as not resumable rather than raising", () => {
    // The old code threw a bespoke "can only retry..." error here.
    expect(
      resumeRun(def, {
        id: 42,
        state: "completed",
        status: "completed",
        vars,
      }),
    ).toBeNull();
    expect(
      resumeRun(def, {
        id: 42,
        state: "failed",
        status: "failed",
        reason: "merge_request_failed",
        vars,
      }),
    ).toBeNull();
  });
});

describe("engine guards", () => {
  it("stops a decision state that loops without ever dispatching", () => {
    const spinning: WorkflowDefinition = {
      workflow: "spin",
      version: 1,
      start: [{ goto: "a" }],
      states: {
        a: { next: [{ goto: "b" }] },
        b: { next: [{ goto: "a" }] },
      },
    };
    expect(() => startRun(spinning, {})).toThrow(/without dispatching/);
  });

  it("reports a transition list that matches nothing", () => {
    const dead: WorkflowDefinition = {
      workflow: "dead",
      version: 1,
      start: [{ when: "false", goto: "a" }],
      states: { a: { call: { skill: "x" }, next: [{ goto: "completed" }] } },
    };
    expect(() => startRun(dead, {})).toThrow(/no transition matched/);
  });
});

describe("validateDefinition", () => {
  it("catches a goto pointing at a state that does not exist", () => {
    const issues = validateDefinition({
      workflow: "x",
      version: 1,
      start: [{ goto: "nowhere" }],
      states: { a: { call: { skill: "s" }, next: [{ goto: "completed" }] } },
    });
    expect(issues).toContainEqual({
      path: "start[0].goto",
      message: "unknown state: nowhere",
    });
  });

  it("catches a transition list with no unconditional fallback", () => {
    // Without one the run dies mid-flight on an input nobody anticipated.
    const issues = validateDefinition({
      workflow: "x",
      version: 1,
      start: [{ goto: "a" }],
      states: {
        a: {
          call: { skill: "s" },
          next: [{ when: "result.ok", goto: "completed" }],
        },
      },
    });
    expect(issues.map((i) => i.path)).toContain("states.a.next");
  });

  it("catches a malformed when expression", () => {
    const issues = validateDefinition({
      workflow: "x",
      version: 1,
      start: [{ when: "result.ok &&", goto: "a" }, { goto: "a" }],
      states: { a: { call: { skill: "s" }, next: [{ goto: "completed" }] } },
    });
    expect(issues.map((i) => i.path)).toContain("start[0].when");
  });

  it("catches a transition with two outcomes", () => {
    const issues = validateDefinition({
      workflow: "x",
      version: 1,
      start: [{ goto: "a", fail: "oops" }],
      states: { a: { call: { skill: "s" }, next: [{ goto: "completed" }] } },
    });
    expect(issues[0].message).toMatch(/more than one/);
  });

  it("allows a computed goto, which is the escape hatch", () => {
    const issues = validateDefinition({
      workflow: "x",
      version: 1,
      start: [{ goto: "a" }],
      states: {
        a: {
          call: { skill: "my.decide" },
          next: [{ goto: "{{result.goto}}" }],
        },
      },
    });
    expect(issues).toEqual([]);
  });
});
