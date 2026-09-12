import { describe, expect, it } from "vitest";
import {
  checkPayload,
  checkTemplatedPayload,
  templatePaths,
} from "../../src/fleet/validation/payload.js";

/**
 * Checking a payload against the `inputSchema` a skill declares on its card.
 *
 * The two callers differ in one way that matters: a person's message carries
 * literal values, a workflow's `call.payload` carries templates that are only
 * resolved at dispatch. What must hold for both is that we never invent an
 * error about a value we cannot see.
 */

const SCHEMA = {
  type: "object",
  properties: {
    requirement: { type: "string" },
    issueUrl: { type: "string" },
    iteration: { type: "number" },
  },
  required: ["requirement", "iteration"],
  additionalProperties: false,
};

describe("checkPayload", () => {
  it("passes a payload that matches", () => {
    expect(
      checkPayload(SCHEMA, { requirement: "Fix login", iteration: 0 }),
    ).toEqual([]);
  });

  it("accepts anything when the skill declares no schema", () => {
    // `inputSchema` is optional on the card, and plenty of agents omit it.
    expect(checkPayload(null, { whatever: true })).toEqual([]);
    expect(checkPayload(undefined, "not even an object")).toEqual([]);
  });

  it("names every problem at once rather than one per round trip", () => {
    const issues = checkPayload(SCHEMA, { iteration: "soon", extra: 1 });
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: "requirement", message: "required, but missing" },
        { path: "extra", message: "not declared by this skill" },
        { path: "iteration", message: "must be number" },
      ]),
    );
  });

  it("says where in a nested payload the problem is", () => {
    const nested = {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    };
    const issues = checkPayload(nested, { files: [{ path: "a.ts" }, { mode: 2 }] });
    // A person says `files[1].path`, not `/files/1/path`.
    expect(issues).toEqual([{ path: "files[1].path", message: "required, but missing" }]);
  });

  it("reports a schema it cannot compile instead of passing everything", () => {
    const issues = checkPayload({ type: "not-a-type" }, { anything: true });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("(schema)");
    expect(issues[0].message).toContain("cannot be compiled");
  });

  it("keeps an unknown keyword rather than refusing the whole schema", () => {
    // A card using more of JSON Schema than we do is the author being
    // thorough, not an error to reject their agent over.
    const issues = checkPayload(
      { type: "object", properties: { a: { type: "string" } }, "x-vendor": "yes" },
      { a: "ok" },
    );
    expect(issues).toEqual([]);
  });
});

describe("templatePaths", () => {
  it("finds a template wherever it sits", () => {
    expect(
      templatePaths({
        plain: "text",
        one: "{{vars.x}}",
        nested: { deep: "see {{vars.y}} here" },
        list: ["literal", "{{vars.z}}"],
      }).sort(),
    ).toEqual(["/list/1", "/nested/deep", "/one"]);
  });

  it("escapes a key containing a slash", () => {
    // Without the escape this pointer would match a different position.
    expect(templatePaths({ "a/b": "{{vars.x}}" })).toEqual(["/a~1b"]);
  });
});

describe("checkTemplatedPayload", () => {
  it("never complains about a value it cannot see", () => {
    // Every value is a template; nothing about their types is knowable.
    expect(
      checkTemplatedPayload(SCHEMA, {
        requirement: "{{vars.requirement}}",
        iteration: "{{vars.iteration}}",
      }),
    ).toEqual([]);
  });

  it("still catches a required key that is simply absent", () => {
    const issues = checkTemplatedPayload(SCHEMA, {
      requirement: "{{vars.requirement}}",
    });
    expect(issues).toEqual([{ path: "iteration", message: "required, but missing" }]);
  });

  it("catches a key the skill does not declare, even when its value is a template", () => {
    // The key is written down even though the value is not: an undeclared key
    // is reported against the parent object, so it survives the exclusion.
    const issues = checkTemplatedPayload(SCHEMA, {
      requirement: "{{vars.requirement}}",
      iteration: 0,
      typo: "{{vars.whatever}}",
    });
    expect(issues).toEqual([{ path: "typo", message: "not declared by this skill" }]);
  });

  it("checks the type of a value written literally", () => {
    const issues = checkTemplatedPayload(SCHEMA, {
      requirement: "{{vars.requirement}}",
      iteration: "three",
    });
    expect(issues).toEqual([{ path: "iteration", message: "must be number" }]);
  });

  it("excludes only the template position, not its siblings", () => {
    const issues = checkTemplatedPayload(SCHEMA, {
      requirement: "{{vars.requirement}}",
      iteration: true,
      extra: "{{vars.x}}",
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: "iteration", message: "must be number" },
        { path: "extra", message: "not declared by this skill" },
      ]),
    );
    expect(issues.some((i) => i.path === "requirement")).toBe(false);
  });

  it("excludes everything under a templated subtree", () => {
    const nested = {
      type: "object",
      properties: { opts: { type: "object", properties: { n: { type: "number" } } } },
    };
    // The whole subtree resolves at dispatch, so nothing inside it is known.
    expect(checkTemplatedPayload(nested, { opts: "{{vars.opts}}" })).toEqual([]);
  });
});
