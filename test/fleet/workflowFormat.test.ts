import { describe, expect, it } from "vitest";
import {
  convertText,
  parseDefinition,
  serializeDefinition,
  templateFor,
} from "../../web/src/workflowFormat";

/**
 * The editor's two input formats.
 *
 * YAML is an editing convenience only: a definition is published as JSON and
 * read back as JSON, so what these functions must get right is the round trip
 * through an object, and never destroying someone's text on the way.
 */

const DEFINITION = {
  workflow: "develop-review-merge",
  version: 1,
  start: [{ goto: "developing" }],
  states: {
    developing: {
      call: { skill: "dev.implement", payload: { requirement: "{{vars.r}}" } },
      next: [{ when: "result.ok", goto: "completed" }, { fail: "no PR opened" }],
    },
  },
};

describe("parseDefinition", () => {
  it("reads the same definition from either format", () => {
    const asJson = parseDefinition(JSON.stringify(DEFINITION), "json");
    const asYaml = parseDefinition(serializeDefinition(DEFINITION, "yaml"), "yaml");
    expect(asJson.value).toEqual(DEFINITION);
    expect(asYaml.value).toEqual(DEFINITION);
  });

  it("keeps a templated payload a string rather than resolving anything", () => {
    // `{{vars.r}}` is a template the engine resolves at dispatch. YAML must
    // hand it over untouched — braces at the start of a scalar are exactly
    // the shape a parser could mistake for a flow mapping.
    const yaml = 'workflow: w\nversion: 1\npayload:\n  requirement: "{{vars.r}}"\n';
    expect(parseDefinition(yaml, "yaml").value).toEqual({
      workflow: "w",
      version: 1,
      payload: { requirement: "{{vars.r}}" },
    });
  });

  it("survives a round trip through YAML with the template intact", () => {
    const text = serializeDefinition(DEFINITION, "yaml");
    expect(parseDefinition(text, "yaml").value).toEqual(DEFINITION);
    expect(text).toContain("{{vars.r}}");
  });

  it("points at the line when YAML does not parse", () => {
    const { value, error } = parseDefinition("workflow: w\n  bad: indent\n", "yaml");
    expect(value).toBeNull();
    expect(error).toMatch(/line \d+/);
  });

  it("reports a JSON syntax error as JSON.parse phrases it", () => {
    const { value, error } = parseDefinition('{"workflow": }', "json");
    expect(value).toBeNull();
    expect(error).toBeTruthy();
  });

  it("refuses text that parses but is not a definition", () => {
    expect(parseDefinition("- a\n- b\n", "yaml").error).toBe("a definition must be a mapping");
    expect(parseDefinition("[1, 2]", "json").error).toBe("a definition must be a JSON object");
    expect(parseDefinition("null", "json").error).toBe("a definition must be a JSON object");
  });

  it("calls empty text empty, rather than letting it read as null", () => {
    // `parse("")` yields null in YAML, which would otherwise surface as the
    // less helpful "must be a mapping".
    expect(parseDefinition("   \n", "yaml").error).toBe("the definition is empty");
    expect(parseDefinition("", "json").error).toBe("the definition is empty");
  });
});

describe("convertText", () => {
  it("rewrites the text when the format changes", () => {
    const json = serializeDefinition(DEFINITION, "json");
    const { text, error } = convertText(json, "json", "yaml");
    expect(error).toBeNull();
    expect(text).toContain("workflow: develop-review-merge");
    expect(parseDefinition(text, "yaml").value).toEqual(DEFINITION);
  });

  it("converts back without losing anything", () => {
    const yaml = serializeDefinition(DEFINITION, "yaml");
    const { text } = convertText(yaml, "yaml", "json");
    expect(JSON.parse(text)).toEqual(DEFINITION);
  });

  it("leaves a half-written definition exactly as it was", () => {
    // Discarding someone's text because they clicked a tab is far worse than
    // staying on the old format until the syntax error is fixed.
    const broken = '{"workflow": "w", ';
    const { text, error } = convertText(broken, "json", "yaml");
    expect(text).toBe(broken);
    expect(error).toBeTruthy();
  });

  it("does nothing when the format did not change", () => {
    const text = '{"workflow": "w"}';
    expect(convertText(text, "json", "json")).toEqual({ text, error: null });
  });
});

describe("templateFor", () => {
  it("produces a parseable starting point in both formats", () => {
    for (const format of ["json", "yaml"] as const) {
      const text = templateFor("my-flow", format);
      const { value, error } = parseDefinition(text, format);
      expect(error).toBeNull();
      expect(value).toMatchObject({ workflow: "my-flow", version: 1 });
    }
  });

  it("uses the YAML template's comments to explain the fallback branch", () => {
    // The reason to offer YAML at all is that a transition with no `when` is
    // the fallback, and nothing in the syntax says so.
    expect(templateFor("x", "yaml")).toContain("#");
    expect(templateFor("x", "json")).not.toContain("#");
  });
});
