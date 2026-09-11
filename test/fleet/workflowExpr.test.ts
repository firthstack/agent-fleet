import { describe, expect, it } from "vitest";
import {
  evaluateCondition,
  evaluateExpr,
  ExprError,
  resolveValue,
} from "../../src/fleet/workflow/expr.js";

const scope = {
  vars: {
    prUrl: "https://github.com/o/r/pull/7",
    reviewUrl: null,
    iteration: 2,
    findings: [{ title: "a" }, { title: "b" }],
    empty: [],
  },
  result: {
    ok: true,
    verdict: "request_changes",
    prUrl: "https://github.com/o/r/pull/8",
  },
  limits: { maxIterations: 7 },
  run: { id: 42, status: "reviewing" },
};

describe("literals and paths", () => {
  it("reads dotted paths, and unknown paths are undefined rather than an error", () => {
    expect(evaluateExpr("vars.iteration", scope)).toBe(2);
    expect(evaluateExpr("run.id", scope)).toBe(42);
    expect(evaluateExpr("vars.nope", scope)).toBeUndefined();
    // A workflow that references a var it never set should branch, not crash.
    expect(evaluateExpr("nothing.at.all", scope)).toBeUndefined();
  });

  it("parses the literal forms the format uses", () => {
    expect(evaluateExpr("true", scope)).toBe(true);
    expect(evaluateExpr("null", scope)).toBe(null);
    expect(evaluateExpr("7", scope)).toBe(7);
    expect(evaluateExpr("'approved'", scope)).toBe("approved");
    expect(evaluateExpr("[]", scope)).toEqual([]);
    expect(evaluateExpr("[1, 'a']", scope)).toEqual([1, "a"]);
  });
});

describe("comparison", () => {
  it("compares the verdict strings the review step returns", () => {
    expect(evaluateCondition("result.verdict == 'request_changes'", scope)).toBe(true);
    expect(evaluateCondition("result.verdict == 'approved'", scope)).toBe(false);
    expect(evaluateCondition("result.verdict != 'approved'", scope)).toBe(true);
  });

  it("treats an unset var and an explicit null as the same thing", () => {
    // `reviewUrl` is null and `nope` was never declared; a workflow author
    // means the same by both.
    expect(evaluateCondition("vars.reviewUrl == null", scope)).toBe(true);
    expect(evaluateCondition("vars.nope == null", scope)).toBe(true);
    expect(evaluateCondition("vars.prUrl != null", scope)).toBe(true);
  });

  it("orders numbers for the iteration guard", () => {
    expect(evaluateCondition("vars.iteration >= limits.maxIterations", scope)).toBe(false);
    expect(evaluateCondition("vars.iteration < limits.maxIterations", scope)).toBe(true);
  });
});

describe("boolean operators", () => {
  it("evaluates the real transition conditions", () => {
    expect(evaluateCondition("result.ok && result.prUrl", scope)).toBe(true);
    expect(evaluateCondition("!result.ok || !result.verdict", scope)).toBe(false);
    expect(
      evaluateCondition("run.status == 'reviewing' && vars.prUrl != null", scope),
    ).toBe(true);
  });

  it("short-circuits, so a guard can protect the access after it", () => {
    // `vars.missing.deep` would be undefined access; the guard must stop first.
    expect(evaluateCondition("vars.nope && vars.nope.deep", scope)).toBe(false);
    expect(evaluateCondition("vars.prUrl != null || vars.nope.deep", scope)).toBe(true);
  });

  it("counts an empty array as false", () => {
    // `findings` being [] should not look like "there are findings".
    expect(evaluateCondition("vars.empty", scope)).toBe(false);
    expect(evaluateCondition("vars.findings", scope)).toBe(true);
  });
});

describe("?? coalescing", () => {
  it("falls back only for null or undefined, not for empty or zero", () => {
    expect(evaluateExpr("vars.reviewUrl ?? 'none'", scope)).toBe("none");
    expect(evaluateExpr("vars.nope ?? 'none'", scope)).toBe("none");
    expect(evaluateExpr("vars.prUrl ?? 'none'", scope)).toBe(
      "https://github.com/o/r/pull/7",
    );
    // 0 is a legitimate iteration, so ?? must not swallow it.
    expect(evaluateExpr("0 ?? 9", scope)).toBe(0);
    expect(evaluateExpr("vars.empty ?? 'none'", scope)).toEqual([]);
  });
});

describe("arithmetic", () => {
  it("increments the iteration counter", () => {
    expect(evaluateExpr("vars.iteration + 1", scope)).toBe(3);
  });

  it("concatenates when either side is a string", () => {
    expect(evaluateExpr("'run-' + run.id", scope)).toBe("run-42");
  });

  it("refuses arithmetic on something that is not a number", () => {
    expect(() => evaluateExpr("vars.prUrl - 1", scope)).toThrow(ExprError);
  });

  it("respects precedence and parentheses", () => {
    expect(evaluateExpr("1 + 2 * 3", scope)).toBe(7);
    expect(evaluateExpr("(1 + 2) * 3", scope)).toBe(9);
  });
});

describe("rejected input", () => {
  it("refuses function calls, keeping the escape hatch the only way out", () => {
    // The moment this parses, the language starts growing (docs §4.1).
    expect(() => evaluateExpr("upper(vars.prUrl)", scope)).toThrow(ExprError);
  });

  it("reports malformed expressions instead of silently yielding undefined", () => {
    for (const bad of ["vars.prUrl ==", "((1)", "1 $ 2", "'unterminated", "1 2"]) {
      expect(() => evaluateExpr(bad, scope), bad).toThrow(ExprError);
    }
  });
});

describe("resolveValue", () => {
  it("keeps a whole-string template's native type", () => {
    // If this stringified, develop.revise would receive "[object Object]".
    expect(resolveValue("{{vars.findings}}", scope)).toEqual([
      { title: "a" },
      { title: "b" },
    ]);
    expect(resolveValue("{{vars.iteration}}", scope)).toBe(2);
  });

  it("interpolates a template embedded in text", () => {
    expect(resolveValue("run {{run.id}} of {{limits.maxIterations}}", scope)).toBe(
      "run 42 of 7",
    );
  });

  it("renders null and undefined as empty inside text", () => {
    expect(resolveValue("[{{vars.reviewUrl}}]", scope)).toBe("[]");
  });

  it("leaves plain strings alone", () => {
    expect(
      resolveValue("codex review passed; external approval required", scope),
    ).toBe("codex review passed; external approval required");
  });

  it("walks nested payload objects and arrays", () => {
    expect(
      resolveValue(
        {
          prUrl: "{{vars.prUrl}}",
          nested: { iteration: "{{vars.iteration + 1}}" },
          list: ["{{run.id}}", "literal"],
        },
        scope,
      ),
    ).toEqual({
      prUrl: "https://github.com/o/r/pull/7",
      nested: { iteration: 3 },
      list: [42, "literal"],
    });
  });
});
