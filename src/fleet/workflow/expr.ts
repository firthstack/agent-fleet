/**
 * The composition layer's expression language (docs/fleet-composition-layer.md §2.2).
 *
 * Deliberately tiny: field access, comparison, boolean operators, `??`, and
 * arithmetic. No function calls, no indexing by expression, no lambdas.
 *
 * That restraint is the design, not laziness. These formats rot by accretion —
 * one built-in, then another, until there is a half-language nobody specified.
 * Anything this cannot express goes through the escape hatch (§2.3), which
 * costs a round trip to an agent and is therefore a visible decision rather
 * than a quiet extension.
 */

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

export interface ExprScope {
  [root: string]: unknown;
}

type TokenType =
  | "number"
  | "string"
  | "ident"
  | "op"
  | "punct"
  | "eof";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const OPERATORS = [
  "&&", "||", "??", "==", "!=", ">=", "<=",
  ">", "<", "!", "+", "-", "*", "/",
];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let value = "";
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          value += src[i + 1];
          i += 2;
          continue;
        }
        value += src[i];
        i += 1;
      }
      if (i >= src.length) throw new ExprError(`unterminated string in: ${src}`);
      i += 1;
      out.push({ type: "string", value, pos: i });
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      let value = "";
      while (i < src.length && /[0-9.]/.test(src[i])) {
        value += src[i];
        i += 1;
      }
      out.push({ type: "number", value, pos: i });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let value = "";
      // Dots are part of the identifier: `vars.prUrl` is one path token.
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) {
        value += src[i];
        i += 1;
      }
      out.push({ type: "ident", value, pos: i });
      continue;
    }

    if (ch === "(" || ch === ")" || ch === "[" || ch === "]" || ch === ",") {
      out.push({ type: "punct", value: ch, pos: i });
      i += 1;
      continue;
    }

    const op = OPERATORS.find((candidate) => src.startsWith(candidate, i));
    if (op) {
      out.push({ type: "op", value: op, pos: i });
      i += op.length;
      continue;
    }

    throw new ExprError(`unexpected character '${ch}' at ${i} in: ${src}`);
  }

  out.push({ type: "eof", value: "", pos: src.length });
  return out;
}

/** Higher binds tighter. */
const BINDING: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "??": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  ">": 5,
  "<=": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
};

function readPath(scope: ExprScope, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function numeric(value: unknown, op: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) {
    throw new ExprError(`operator '${op}' needs a number, got ${JSON.stringify(value)}`);
  }
  return n;
}

type Node =
  | { t: "lit"; v: unknown }
  | { t: "path"; p: string }
  | { t: "arr"; items: Node[] }
  | { t: "unary"; op: string; e: Node }
  | { t: "bin"; op: string; l: Node; r: Node };

/**
 * Parsing is separate from evaluation on purpose.
 *
 * `checkExpr` needs to know an expression is well-formed without having any
 * data to run it against — `vars.iteration >= limits.maxIterations` is
 * perfectly valid but throws if evaluated against an empty scope. Evaluating
 * to validate would reject correct workflows.
 *
 * It also lets the engine parse once and evaluate per step instead of
 * re-parsing every transition on every hop.
 */
class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.index];
  }

  private take(): Token {
    return this.tokens[this.index++];
  }

  parse(minBinding = 0): Node {
    let left = this.unary();

    for (;;) {
      const token = this.peek();
      if (token.type !== "op") break;
      const binding = BINDING[token.value];
      if (binding === undefined || binding < minBinding) break;
      this.take();
      const right = this.parse(binding + 1);
      left = { t: "bin", op: token.value, l: left, r: right };
    }

    return left;
  }

  private unary(): Node {
    const token = this.peek();
    if (token.type === "op" && (token.value === "!" || token.value === "-")) {
      this.take();
      return { t: "unary", op: token.value, e: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.take();

    if (token.type === "number") return { t: "lit", v: Number(token.value) };
    if (token.type === "string") return { t: "lit", v: token.value };

    if (token.type === "punct" && token.value === "(") {
      const node = this.parse();
      const close = this.take();
      if (close.value !== ")") throw new ExprError(`expected ')' in: ${this.src}`);
      return node;
    }

    if (token.type === "punct" && token.value === "[") {
      const items: Node[] = [];
      if (this.peek().value === "]") {
        this.take();
        return { t: "arr", items };
      }
      for (;;) {
        items.push(this.parse());
        const next = this.take();
        if (next.value === "]") return { t: "arr", items };
        if (next.value !== ",") throw new ExprError(`expected ',' or ']' in: ${this.src}`);
      }
    }

    if (token.type === "ident") {
      if (token.value === "true") return { t: "lit", v: true };
      if (token.value === "false") return { t: "lit", v: false };
      if (token.value === "null") return { t: "lit", v: null };
      return { t: "path", p: token.value };
    }

    throw new ExprError(`unexpected ${token.type} '${token.value}' in: ${this.src}`);
  }

  expectEnd(): void {
    if (this.peek().type !== "eof") {
      throw new ExprError(
        `unexpected trailing '${this.peek().value}' in: ${this.src}`,
      );
    }
  }
}

function nullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function binary(op: string, left: unknown, right: unknown): unknown {
  switch (op) {
    // Loose on null vs undefined: a var that was never set and one set to
    // null mean the same thing to a workflow author.
    case "==":
      return nullish(left) && nullish(right) ? true : left === right;
    case "!=":
      return nullish(left) && nullish(right) ? false : left !== right;
    case "<":
      return numeric(left, op) < numeric(right, op);
    case ">":
      return numeric(left, op) > numeric(right, op);
    case "<=":
      return numeric(left, op) <= numeric(right, op);
    case ">=":
      return numeric(left, op) >= numeric(right, op);
    case "+":
      // Either side being a string concatenates. This is also how a workflow
      // coerces a number to a string without a cast built-in: `'' + run.id`.
      if (typeof left === "string" || typeof right === "string") {
        return `${left}${right}`;
      }
      return numeric(left, op) + numeric(right, op);
    case "-":
      return numeric(left, op) - numeric(right, op);
    case "*":
      return numeric(left, op) * numeric(right, op);
    case "/": {
      const divisor = numeric(right, op);
      if (divisor === 0) throw new ExprError("division by zero");
      return numeric(left, op) / divisor;
    }
    default:
      throw new ExprError(`unsupported operator '${op}'`);
  }
}

function evalNode(node: Node, scope: ExprScope): unknown {
  switch (node.t) {
    case "lit":
      return node.v;
    case "path":
      return readPath(scope, node.p);
    case "arr":
      return node.items.map((item) => evalNode(item, scope));
    case "unary":
      return node.op === "!"
        ? !truthy(evalNode(node.e, scope))
        : -numeric(evalNode(node.e, scope), "-");
    case "bin": {
      // Short-circuit before touching the right side, so `a && a.b` is safe.
      if (node.op === "&&") {
        return truthy(evalNode(node.l, scope)) ? truthy(evalNode(node.r, scope)) : false;
      }
      if (node.op === "||") {
        return truthy(evalNode(node.l, scope)) ? true : truthy(evalNode(node.r, scope));
      }
      if (node.op === "??") {
        const left = evalNode(node.l, scope);
        return nullish(left) ? evalNode(node.r, scope) : left;
      }
      return binary(node.op, evalNode(node.l, scope), evalNode(node.r, scope));
    }
  }
}

const CACHE = new Map<string, Node>();

/** Parse and cache. Throws ExprError on malformed input. */
export function parseExpr(source: string): Node {
  const cached = CACHE.get(source);
  if (cached) return cached;
  const parser = new Parser(tokenize(source), source);
  const node = parser.parse();
  parser.expectEnd();
  CACHE.set(source, node);
  return node;
}

/** Syntax-only check, for validating a definition with no data to run it on. */
export function checkExpr(source: string): void {
  parseExpr(source);
}

/** Evaluate a bare expression, e.g. a transition's `when`. */
export function evaluateExpr(source: string, scope: ExprScope): unknown {
  return evalNode(parseExpr(source), scope);
}

export function evaluateCondition(source: string, scope: ExprScope): boolean {
  return truthy(evaluateExpr(source, scope));
}

const TEMPLATE = /^\{\{([\s\S]+)\}\}$/;

/**
 * Resolve a payload or `set` value.
 *
 * A string that is exactly one `{{ … }}` yields the raw value, so
 * `"{{vars.findings}}"` stays an array instead of becoming "[object Object]".
 * Templates embedded in surrounding text interpolate as strings.
 */
export function resolveValue(value: unknown, scope: ExprScope): unknown {
  if (typeof value === "string") {
    const whole = TEMPLATE.exec(value.trim());
    if (whole) return evaluateExpr(whole[1], scope);
    if (!value.includes("{{")) return value;
    return value.replace(/\{\{([\s\S]+?)\}\}/g, (_m, expr: string) => {
      const resolved = evaluateExpr(expr, scope);
      return resolved === null || resolved === undefined ? "" : String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, scope));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveValue(item, scope);
    }
    return out;
  }

  return value;
}
