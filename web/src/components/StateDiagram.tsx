import { useMemo } from "react";
import type { WorkflowDefinition, WorkflowTransition } from "../api.ts";

/**
 * The state graph, derived from the definition itself (docs §7).
 *
 * The loop is the whole point. `revising → pr_opened → reviewing → revising`
 * is the shape a DAG cannot express and the reason this format exists, so a
 * back edge is drawn deliberately — routed around the side, dashed — rather
 * than left to overlap the forward flow and disappear.
 */

const NODE_W = 150;
const NODE_H = 38;
const COL_GAP = 34;
const ROW_GAP = 58;
const PAD = 20;
/** Room to the right of the widest row for back edges to travel in. */
const LOOP_LANE = 46;

interface Edge {
  from: string;
  to: string;
  label: string;
  kind: "goto" | "fail" | "escalate";
}

function outcome(t: WorkflowTransition): { to: string; kind: Edge["kind"] } | null {
  if (t.goto !== undefined) return { to: t.goto, kind: "goto" };
  if (t.fail !== undefined) return { to: "failed", kind: "fail" };
  if (t.escalate !== undefined) return { to: "needs_human", kind: "escalate" };
  return null;
}

function label(t: WorkflowTransition): string {
  if (t.when) return t.when.length > 28 ? `${t.when.slice(0, 27)}…` : t.when;
  // No `when` is the fallback branch — the one that runs when nothing else
  // matched. Saying "otherwise" is more honest than leaving it blank.
  return "otherwise";
}

export function buildGraph(def: WorkflowDefinition | null): {
  nodes: string[];
  edges: Edge[];
  depth: Map<string, number>;
} {
  const edges: Edge[] = [];
  const states = def?.states ?? {};
  const nodes = new Set<string>(Object.keys(states));

  for (const t of def?.start ?? []) {
    const out = outcome(t);
    if (!out) continue;
    nodes.add(out.to);
    edges.push({ from: "start", to: out.to, label: label(t), kind: out.kind });
  }
  for (const [name, state] of Object.entries(states)) {
    for (const t of state.next ?? []) {
      const out = outcome(t);
      if (!out) continue;
      nodes.add(out.to);
      edges.push({ from: name, to: out.to, label: label(t), kind: out.kind });
    }
  }

  // Depth by BFS from `start`, which is what makes a back edge identifiable:
  // an edge whose target is not deeper than its source.
  const depth = new Map<string, number>([["start", 0]]);
  const queue = ["start"];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const edge of edges.filter((e) => e.from === at)) {
      if (depth.has(edge.to)) continue;
      depth.set(edge.to, depth.get(at)! + 1);
      queue.push(edge.to);
    }
  }
  // A state nothing reaches still belongs on the canvas — an orphan is
  // exactly the kind of thing the picture should make obvious.
  let orphanDepth = Math.max(0, ...[...depth.values()]) + 1;
  for (const node of nodes) {
    if (!depth.has(node)) depth.set(node, orphanDepth);
  }

  return { nodes: ["start", ...nodes], edges, depth };
}

export function StateDiagram({ definition }: { definition: WorkflowDefinition | null }) {
  const layout = useMemo(() => {
    const { nodes, edges, depth } = buildGraph(definition);
    const rows = new Map<number, string[]>();
    for (const node of nodes) {
      const d = depth.get(node) ?? 0;
      rows.set(d, [...(rows.get(d) ?? []), node]);
    }

    const pos = new Map<string, { x: number; y: number }>();
    let widest = 0;
    for (const [d, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      const width = row.length * NODE_W + (row.length - 1) * COL_GAP;
      widest = Math.max(widest, width);
      row.forEach((node, i) => {
        pos.set(node, {
          x: PAD + i * (NODE_W + COL_GAP),
          y: PAD + d * (NODE_H + ROW_GAP),
        });
      });
    }
    const height = PAD * 2 + rows.size * (NODE_H + ROW_GAP) - ROW_GAP;
    return { edges, pos, depth, width: PAD * 2 + widest + LOOP_LANE, height };
  }, [definition]);

  if (!definition || Object.keys(definition.states ?? {}).length === 0) {
    return <p className="lead">Nothing to draw yet.</p>;
  }

  const { edges, pos, depth, width, height } = layout;
  const loopLaneX = width - PAD;

  return (
    <div className="diagram">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" className="arrow-head" />
          </marker>
        </defs>

        {edges.map((edge, i) => {
          const from = pos.get(edge.from);
          const to = pos.get(edge.to);
          if (!from || !to) return null;
          const back = (depth.get(edge.to) ?? 0) <= (depth.get(edge.from) ?? 0);
          const x1 = from.x + NODE_W / 2;
          const y1 = from.y + NODE_H;
          const x2 = to.x + NODE_W / 2;
          const y2 = to.y;

          // A back edge leaves the right side, runs up its own lane and
          // re-enters from the right, so it never hides under a forward one.
          const d = back
            ? `M${from.x + NODE_W},${from.y + NODE_H / 2} H${loopLaneX} V${to.y + NODE_H / 2} H${to.x + NODE_W}`
            : `M${x1},${y1} C${x1},${y1 + ROW_GAP / 2} ${x2},${y2 - ROW_GAP / 2} ${x2},${y2}`;

          return (
            <g key={`${edge.from}-${edge.to}-${i}`} className={`edge ${edge.kind}${back ? " back" : ""}`}>
              <path d={d} markerEnd="url(#arrow)" fill="none" />
              <text
                x={back ? loopLaneX - 6 : (x1 + x2) / 2 + 6}
                y={back ? (from.y + to.y) / 2 + NODE_H / 2 : (y1 + y2) / 2}
                textAnchor={back ? "end" : "start"}
              >
                {edge.label}
              </text>
            </g>
          );
        })}

        {[...pos.entries()].map(([node, at]) => {
          const state = definition.states?.[node];
          const terminal = ["completed", "failed", "cancelled", "needs_human"].includes(node);
          const kind = node === "start" ? "start" : terminal ? "terminal" : state?.call ? "call" : "decision";
          return (
            <g key={node} className={`node ${kind}`}>
              <rect x={at.x} y={at.y} width={NODE_W} height={NODE_H} rx="7" />
              <text x={at.x + NODE_W / 2} y={at.y + (state?.call ? 16 : NODE_H / 2 + 4)} textAnchor="middle">
                {node}
              </text>
              {state?.call ? (
                <text x={at.x + NODE_W / 2} y={at.y + 29} textAnchor="middle" className="node-sub">
                  {state.call.skill}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
