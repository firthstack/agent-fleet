import { checkExpr, evaluateCondition, evaluateExpr, ExprError, resolveValue } from "./expr.js";

/**
 * The composition engine (docs/fleet-composition-layer.md §2).
 *
 * Everything here is a pure function over a definition and a run snapshot.
 * Persistence, dispatch and retries belong to the gateway, which already
 * implements them for the transport (gateway docs §7-8); the engine only
 * answers "what happens next".
 *
 * That split is what makes an event-driven engine possible: there is no
 * long-lived saga to lose on restart, only a row plus this function.
 */

export interface WorkflowVarSpec {
  /** Path into the dispatch input, e.g. `input.requirement`. */
  from?: string;
  required?: boolean;
  init?: unknown;
  /** Used when `from` yields nothing. A literal, or a regex extraction. */
  else?: unknown;
}

export interface WorkflowTransition {
  when?: string;
  set?: Record<string, unknown>;
  goto?: string;
  fail?: string;
  escalate?: string;
}

export interface WorkflowState {
  /** Written to the run's status column; defaults to the state name. */
  status?: string;
  call?: { skill: string; payload?: Record<string, unknown> };
  /** Applied after the state's work — for a call state, with `result` in scope. */
  set?: Record<string, unknown>;
  next?: WorkflowTransition[];
}

export interface WorkflowDefinition {
  workflow: string;
  version: number;
  description?: string;
  dedupeBy?: string[];
  vars?: Record<string, WorkflowVarSpec>;
  limits?: Record<string, number>;
  start: WorkflowTransition[];
  states: Record<string, WorkflowState>;
  resume?: WorkflowTransition[];
}

export type WorkflowVars = Record<string, unknown>;

/** States the engine treats as terminal without them being declared. */
export const TERMINAL_STATES = ["completed", "failed", "cancelled", "needs_human"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/**
 * Every state entered on the way to this decision, in order, ending with the
 * one the decision names.
 *
 * A decision state that dispatches nothing — `pr_opened` marking that a PR
 * now exists — would otherwise be invisible, and the run viewer would show a
 * jump from "developing" straight to "reviewing". The imperative code it
 * replaces recorded that milestone, so the engine has to surface it.
 */
export type DecisionBase = { path: string[]; vars: WorkflowVars };

export type Decision =
  | (DecisionBase & {
      kind: "call";
      state: string;
      status: string;
      skillId: string;
      payload: Record<string, unknown>;
    })
  | (DecisionBase & {
      kind: "terminal";
      state: TerminalState;
      status: string;
      reason?: string;
    });

export interface RunSnapshot {
  id: number | string;
  state: string;
  status: string;
  reason?: string | null;
  vars: WorkflowVars;
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

/**
 * A chain of decision states with no call could loop forever without ever
 * dispatching, which would spin the engine rather than the workflow.
 */
const MAX_SILENT_HOPS = 32;

function isTerminal(name: string): name is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(name);
}

function scopeFor(args: {
  def: WorkflowDefinition;
  vars: WorkflowVars;
  run?: Partial<RunSnapshot>;
  result?: unknown;
  input?: unknown;
}): Record<string, unknown> {
  return {
    vars: args.vars,
    limits: args.def.limits ?? {},
    run: args.run ?? {},
    result: args.result ?? {},
    input: args.input ?? {},
  };
}

function applySet(
  set: Record<string, unknown> | undefined,
  vars: WorkflowVars,
  scope: Record<string, unknown>,
): WorkflowVars {
  if (!set) return vars;
  const next = { ...vars };
  for (const [name, expr] of Object.entries(set)) {
    next[name] = resolveValue(expr, { ...scope, vars: next });
  }
  return next;
}

function pickTransition(
  transitions: WorkflowTransition[],
  scope: Record<string, unknown>,
  where: string,
): WorkflowTransition {
  for (const transition of transitions) {
    if (transition.when === undefined) return transition;
    if (evaluateCondition(transition.when, scope)) return transition;
  }
  throw new WorkflowError(
    `no transition matched in ${where}; add an unconditional fallback`,
  );
}

/** Which other vars a spec reads, so initialisation can be ordered by need. */
function varDependencies(spec: WorkflowVarSpec): string[] {
  const sources: string[] = [];
  if (typeof spec.from === "string") sources.push(spec.from);
  if (spec.else && typeof spec.else === "object" && "over" in (spec.else as object)) {
    const over = (spec.else as { over?: unknown }).over;
    if (typeof over === "string") sources.push(over);
  } else if (typeof spec.else === "string") {
    sources.push(spec.else);
  }

  const names: string[] = [];
  for (const source of sources) {
    for (const match of source.matchAll(/\bvars\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * Build the initial variables from the dispatch input.
 *
 * Resolution follows **dependency order, not declaration order**. A definition
 * round-trips through Postgres, and `jsonb` reorders object keys — so the
 * author's ordering is not something the engine can rely on. Deriving one var
 * from another (`issueUrl` extracted out of `requirement`) silently produced
 * null once the storage layer put `issueUrl` first.
 */
export function initVars(
  def: WorkflowDefinition,
  input: Record<string, unknown>,
): WorkflowVars {
  const specs = Object.entries(def.vars ?? {});
  const vars: WorkflowVars = {};
  const resolved = new Set<string>();
  const declared = new Set(specs.map(([name]) => name));

  function resolveOne(name: string, spec: WorkflowVarSpec): void {
    const scope = scopeFor({ def, vars, input });
    let value: unknown;

    if (spec.from) value = evaluateExpr(spec.from, scope);

    if (value === undefined || value === null) {
      if (spec.else !== undefined) {
        value = resolveVarElse(spec.else, scope);
      } else if (spec.init !== undefined) {
        value = spec.init;
      }
    }

    if ((value === undefined || value === null) && spec.required) {
      throw new WorkflowError(`workflow input is missing required var: ${name}`);
    }

    vars[name] = value === undefined ? null : value;
    resolved.add(name);
  }

  // Repeated passes until nothing more can be resolved. The set is tiny, and
  // this is immune to however the storage layer happens to order keys.
  let progress = true;
  while (progress) {
    progress = false;
    for (const [name, spec] of specs) {
      if (resolved.has(name)) continue;
      const pending = varDependencies(spec).filter(
        (dep) => declared.has(dep) && !resolved.has(dep) && dep !== name,
      );
      if (pending.length > 0) continue;
      resolveOne(name, spec);
      progress = true;
    }
  }

  // Anything left is part of a cycle; resolve it so the run still starts,
  // rather than wedging on a definition mistake at dispatch time.
  for (const [name, spec] of specs) {
    if (!resolved.has(name)) resolveOne(name, spec);
  }

  return vars;
}

/**
 * The one extraction primitive the format admits (docs §4.1): pulling a value
 * out of free text. Everything beyond this goes through the escape hatch —
 * a second built-in is where these languages start to rot.
 */
function resolveVarElse(spec: unknown, scope: Record<string, unknown>): unknown {
  if (spec && typeof spec === "object" && "regex" in (spec as object)) {
    const { regex, over } = spec as { regex: string; over: string };
    const subject = evaluateExpr(over, scope);
    if (typeof subject !== "string") return null;
    const match = new RegExp(regex).exec(subject);
    return match ? match[0] : null;
  }
  return resolveValue(spec, scope);
}

function enterState(
  def: WorkflowDefinition,
  stateName: string,
  vars: WorkflowVars,
  run: Partial<RunSnapshot>,
  hops: number,
  path: string[] = [],
): Decision {
  if (hops > MAX_SILENT_HOPS) {
    throw new WorkflowError(
      `workflow made ${MAX_SILENT_HOPS} transitions without dispatching; ` +
        "a decision state probably loops back on itself",
    );
  }

  const walked = [...path, stateName];

  if (isTerminal(stateName)) {
    return {
      kind: "terminal",
      state: stateName,
      status: stateName,
      vars,
      path: walked,
    };
  }

  const state = def.states[stateName];
  if (!state) throw new WorkflowError(`unknown state: ${stateName}`);
  const status = state.status ?? stateName;

  // A call state stops here: the gateway dispatches, and the result comes
  // back through advance().
  if (state.call) {
    const scope = scopeFor({ def, vars, run });
    return {
      kind: "call",
      state: stateName,
      status,
      skillId: state.call.skill,
      payload: (resolveValue(state.call.payload ?? {}, scope) ?? {}) as Record<
        string,
        unknown
      >,
      vars,
      path: walked,
    };
  }

  // A decision state does its work immediately and keeps walking.
  const scope = scopeFor({ def, vars, run });
  const nextVars = applySet(state.set, vars, scope);
  if (!state.next || state.next.length === 0) {
    throw new WorkflowError(`state ${stateName} has no call and no transitions`);
  }
  return follow(
    def,
    state.next,
    nextVars,
    { ...run, state: stateName, status },
    `state ${stateName}`,
    hops + 1,
    undefined,
    walked,
  );
}

function follow(
  def: WorkflowDefinition,
  transitions: WorkflowTransition[],
  vars: WorkflowVars,
  run: Partial<RunSnapshot>,
  where: string,
  hops: number,
  result?: unknown,
  path: string[] = [],
): Decision {
  const scope = scopeFor({ def, vars, run, result });
  const transition = pickTransition(transitions, scope, where);
  const nextVars = applySet(transition.set, vars, scope);

  if (transition.fail !== undefined) {
    return {
      kind: "terminal",
      state: "failed",
      status: "failed",
      reason: transition.fail,
      vars: nextVars,
      path: [...path, "failed"],
    };
  }
  if (transition.escalate !== undefined) {
    return {
      kind: "terminal",
      state: "needs_human",
      status: "needs_human",
      reason: transition.escalate,
      vars: nextVars,
      path: [...path, "needs_human"],
    };
  }
  if (!transition.goto) {
    throw new WorkflowError(
      `transition in ${where} has none of goto, fail or escalate`,
    );
  }

  const target = resolveValue(transition.goto, scope);
  if (typeof target !== "string") {
    throw new WorkflowError(`goto in ${where} did not resolve to a state name`);
  }
  return enterState(def, target, nextVars, run, hops + 1, path);
}

/** First decision for a fresh run. */
export function startRun(
  def: WorkflowDefinition,
  input: Record<string, unknown>,
): Decision {
  const vars = initVars(def, input);
  return follow(def, def.start, vars, {}, "start", 0);
}

/** Next decision after the current state's call has come back. */
export function advance(
  def: WorkflowDefinition,
  snapshot: RunSnapshot,
  result: unknown,
): Decision {
  const state = def.states[snapshot.state];
  if (!state) throw new WorkflowError(`unknown state: ${snapshot.state}`);
  if (!state.call) {
    throw new WorkflowError(
      `state ${snapshot.state} has no call, so it cannot receive a result`,
    );
  }
  if (!state.next || state.next.length === 0) {
    throw new WorkflowError(`state ${snapshot.state} has no transitions`);
  }

  const scope = scopeFor({ def, vars: snapshot.vars, run: snapshot, result });
  const vars = applySet(state.set, snapshot.vars, scope);
  return follow(
    def,
    state.next,
    vars,
    snapshot,
    `state ${snapshot.state}`,
    0,
    result,
  );
}

/**
 * Where an interrupted run picks up (docs §4.4). Declaring these replaces the
 * hand-written retry branches, and "no rule matched" is simply not resumable
 * rather than a bespoke error.
 */
export function resumeRun(
  def: WorkflowDefinition,
  snapshot: RunSnapshot,
): Decision | null {
  if (!def.resume || def.resume.length === 0) return null;
  const scope = scopeFor({ def, vars: snapshot.vars, run: snapshot });
  for (const transition of def.resume) {
    if (transition.when !== undefined && !evaluateCondition(transition.when, scope)) {
      continue;
    }
    const vars = applySet(transition.set, snapshot.vars, scope);
    if (!transition.goto) {
      throw new WorkflowError("a resume rule must use goto");
    }
    return enterState(def, transition.goto, vars, snapshot, 0);
  }
  return null;
}

/**
 * Every skill the definition can invoke. The gateway preflights these before
 * the first dispatch, which replaces the hand-written capability checks the
 * old workflow agent ran at the top of each entry point.
 */
export function requiredSkills(def: WorkflowDefinition): string[] {
  const skills = new Set<string>();
  for (const state of Object.values(def.states)) {
    if (state.call?.skill) skills.add(state.call.skill);
  }
  return [...skills].sort();
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Static checks. A definition that fails these would break mid-run, hours
 * into real work, so they run at publish time instead.
 */
export function validateDefinition(def: WorkflowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = new Set([...Object.keys(def.states ?? {}), ...TERMINAL_STATES]);

  if (!def.workflow) issues.push({ path: "workflow", message: "name is required" });
  if (typeof def.version !== "number") {
    issues.push({ path: "version", message: "version must be a number" });
  }
  if (!def.states || Object.keys(def.states).length === 0) {
    issues.push({ path: "states", message: "at least one state is required" });
  }
  if (!Array.isArray(def.start) || def.start.length === 0) {
    issues.push({ path: "start", message: "start must list at least one transition" });
  }

  const checkTransitions = (
    transitions: WorkflowTransition[] | undefined,
    path: string,
    requireFallback: boolean,
  ) => {
    if (!transitions) return;
    transitions.forEach((transition, i) => {
      const at = `${path}[${i}]`;
      const outcomes = [transition.goto, transition.fail, transition.escalate].filter(
        (v) => v !== undefined,
      );
      if (outcomes.length === 0) {
        issues.push({ path: at, message: "needs one of goto, fail or escalate" });
      }
      if (outcomes.length > 1) {
        issues.push({ path: at, message: "has more than one of goto, fail, escalate" });
      }
      if (transition.when !== undefined) {
        // Syntax only. Evaluating here would reject correct expressions:
        // `vars.iteration >= limits.maxIterations` is valid but throws
        // against the empty scope validation would have to invent.
        try {
          checkExpr(transition.when);
        } catch (err) {
          if (err instanceof ExprError) {
            issues.push({ path: `${at}.when`, message: err.message });
          }
        }
      }
      // A computed goto is the escape hatch; it cannot be checked statically.
      if (
        transition.goto &&
        !transition.goto.includes("{{") &&
        !known.has(transition.goto)
      ) {
        issues.push({ path: `${at}.goto`, message: `unknown state: ${transition.goto}` });
      }
    });

    if (requireFallback && transitions.length > 0) {
      const hasFallback = transitions.some((t) => t.when === undefined);
      if (!hasFallback) {
        // Without one, a run dies mid-flight on an input nobody anticipated.
        issues.push({
          path,
          message: "every branch is conditional; add an unconditional fallback",
        });
      }
    }
  };

  checkTransitions(def.start, "start", true);
  checkTransitions(def.resume, "resume", false);

  for (const [name, state] of Object.entries(def.states ?? {})) {
    if (!state.call && (!state.next || state.next.length === 0)) {
      issues.push({
        path: `states.${name}`,
        message: "a state with no call must have transitions",
      });
    }
    if (state.call && !state.call.skill) {
      issues.push({ path: `states.${name}.call`, message: "skill is required" });
    }
    checkTransitions(state.next, `states.${name}.next`, Boolean(state.call));
  }

  return issues;
}
