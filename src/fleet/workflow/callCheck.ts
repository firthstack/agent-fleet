import type { WorkflowDefinition } from "./engine.js";
import { checkTemplatedPayload } from "../validation/payload.js";

/**
 * Checking a definition against the fleet it will actually run on
 * (docs/fleet-console.md §7).
 *
 * `validateDefinition` checks the definition against itself — a `goto` with
 * nowhere to go, a transition with no fallback. This checks it against the
 * agents the tenant has connected: does anything offer the skill each `call`
 * names, and does the payload match what that skill says it accepts.
 *
 * These are **warnings, not errors**. A definition may legitimately be
 * written before the agent that serves it exists, and blocking publication on
 * "no agent offers this yet" would force people to connect agents in an order
 * the gateway has no business dictating. What it buys is that the two
 * failures you would otherwise meet hours later — dispatch refusing because
 * nothing offers the skill, or the agent rejecting the payload — are visible
 * while the definition is still on screen.
 */

export interface SkillEntry {
  /** Every agent in the tenant advertising this skill. */
  agentIds: string[];
  /** From the first card that declared one; may be absent. */
  inputSchema?: unknown;
}

export type SkillIndex = Map<string, SkillEntry>;

export interface CallWarning {
  path: string;
  message: string;
}

/** Build the index from the cards the tenant's agents were registered with. */
export function skillIndex(
  agents: Array<{ agentId: string; card: { skills?: Array<{ id: string; inputSchema?: unknown }> } }>,
): SkillIndex {
  const index: SkillIndex = new Map();
  for (const agent of agents) {
    for (const skill of agent.card.skills ?? []) {
      const entry = index.get(skill.id) ?? { agentIds: [] };
      entry.agentIds.push(agent.agentId);
      if (entry.inputSchema === undefined && skill.inputSchema !== undefined) {
        entry.inputSchema = skill.inputSchema;
      }
      index.set(skill.id, entry);
    }
  }
  return index;
}

export function checkCallPayloads(
  def: WorkflowDefinition,
  index: SkillIndex,
): CallWarning[] {
  const warnings: CallWarning[] = [];

  for (const [stateName, state] of Object.entries(def.states ?? {})) {
    const call = state?.call;
    if (!call || typeof call.skill !== "string") continue;
    const at = `states.${stateName}.call`;
    const entry = index.get(call.skill);

    if (!entry) {
      // Exactly what the dispatcher will refuse with at run time — except
      // that there, the run is already created and then strands.
      warnings.push({
        path: `${at}.skill`,
        message: `no agent in this tenant offers ${call.skill}`,
      });
      continue;
    }

    if (entry.agentIds.length > 1) {
      // The gateway never picks on the caller's behalf, so this is a refusal
      // at dispatch, not a coin flip.
      warnings.push({
        path: `${at}.skill`,
        message:
          `${call.skill} is offered by ${entry.agentIds.length} agents ` +
          `(${entry.agentIds.join(", ")}); dispatch will refuse to choose`,
      });
    }

    for (const issue of checkTemplatedPayload(entry.inputSchema, call.payload ?? {})) {
      warnings.push({
        path: issue.path === "(payload)" ? `${at}.payload` : `${at}.payload.${issue.path}`,
        message: issue.message,
      });
    }
  }

  return warnings;
}
