// v0.7.3 dependency graph module — build/validate the DAG, compute ready-set,
// and produce deterministic non-overlap batches.
//
// Per spec rev5 §5.3. Cross-slice validation (unknown ids, cycles) is owned
// here; intra-slice block parsing lives in plan-parsers.js.
//
// Exports:
//   buildDAG(planPath) -> { ok: true, dag, filesIndex, digest } | { ok: false, halt }
//   computeReadySet(dag, sliceStates) -> string[]
//   maximalFirstFitNonOverlap(readySet, filesIndex) -> string[]
//   computeDigest(dag) -> string  // SHA-256 hex
//   enumerateDescendants(dag, sliceId) -> string[]  // for failure cascade
//   DependencyGraphError class

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  enumerateSliceIds,
  extractSliceSection,
  parseFilesBlock,
  parseDependsOnBlock,
  PlanParseError,
} from './plan-parsers.js';

export class DependencyGraphError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'DependencyGraphError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Convert a slice id to its numeric portion for sort comparison.
 * "slice-3" → 3. Returns Infinity for malformed ids (sorts last).
 */
function sliceNumeric(id) {
  const m = String(id).match(/^slice-(\d+)$/);
  return m ? Number(m[1]) : Infinity;
}

function sortByNumeric(ids) {
  return [...ids].sort((a, b) => sliceNumeric(a) - sliceNumeric(b));
}

/**
 * Build the DAG from a plan markdown file.
 *
 * Returns:
 *   { ok: true, dag: { nodes: { sliceId: { dependsOn: string[] } } },
 *     filesIndex: { sliceId: Set<string> },
 *     digest: string }
 *
 * Or:
 *   { ok: false, halt: { reason, detail } }  // for any validation failure
 *
 * Validation:
 *   - extractSliceSection / parseFilesBlock / parseDependsOnBlock errors
 *     surface as halts with their respective codes
 *   - DependsOn referencing an unknown slice id → halt 'dep-unknown-slice'
 *   - Cycle in the graph → halt 'dep-cycle' with cycle path in detail
 */
export function buildDAG(planPath) {
  let planText;
  try {
    planText = readFileSync(planPath, 'utf8');
  } catch (e) {
    return { ok: false, halt: { reason: 'plan-read-failed', detail: e.message } };
  }

  const sliceIds = enumerateSliceIds(planText);
  if (sliceIds.length === 0) {
    return { ok: false, halt: { reason: 'plan-no-slices', detail: 'plan contains no `## Slice N:` headers' } };
  }

  const dag = { nodes: {} };
  const filesIndex = {};

  // First pass: parse each slice's Files + DependsOn blocks.
  for (const sliceId of sliceIds) {
    const section = extractSliceSection(planText, sliceId);
    let files, dependsOn;
    try {
      files = parseFilesBlock(section);
      dependsOn = parseDependsOnBlock(section, sliceId);
    } catch (e) {
      if (e instanceof PlanParseError) {
        return { ok: false, halt: { reason: e.code, detail: `[${sliceId}] ${e.message}` } };
      }
      throw e;
    }
    dag.nodes[sliceId] = { dependsOn };
    filesIndex[sliceId] = new Set(files);
  }

  // Second pass: validate every DependsOn references an existing slice.
  const sliceIdSet = new Set(sliceIds);
  for (const [sliceId, node] of Object.entries(dag.nodes)) {
    for (const dep of node.dependsOn) {
      if (!sliceIdSet.has(dep)) {
        return {
          ok: false,
          halt: {
            reason: 'dep-unknown-slice',
            detail: `[${sliceId}] DependsOn references "${dep}" which does not exist in the plan`,
          },
        };
      }
    }
  }

  // Third pass: cycle detection via 3-color DFS.
  // Color 0 = unvisited, 1 = in current path, 2 = fully explored.
  const color = new Map();
  for (const id of sliceIds) color.set(id, 0);
  const stack = [];

  function dfs(node) {
    color.set(node, 1);
    stack.push(node);
    for (const dep of dag.nodes[node].dependsOn) {
      const c = color.get(dep);
      if (c === 1) {
        // Cycle: dep is on the current path.
        const cycleStart = stack.indexOf(dep);
        const cyclePath = stack.slice(cycleStart).concat([dep]);
        return { cycle: cyclePath };
      }
      if (c === 0) {
        const r = dfs(dep);
        if (r) return r;
      }
    }
    color.set(node, 2);
    stack.pop();
    return null;
  }

  for (const id of sliceIds) {
    if (color.get(id) === 0) {
      const result = dfs(id);
      if (result) {
        return {
          ok: false,
          halt: {
            reason: 'dep-cycle',
            detail: `cycle detected: ${result.cycle.join(' → ')}`,
          },
        };
      }
    }
  }

  return {
    ok: true,
    dag,
    filesIndex,
    digest: computeDigest(dag),
  };
}

/**
 * Compute SHA-256 hex digest over canonical JSON of the DAG.
 * Stable across reloads as long as plan content is unchanged.
 *
 * Canonical form: { nodes: sortedSliceIds.map(id => [id, sortedDependsOn]) }
 */
export function computeDigest(dag) {
  const sortedIds = sortByNumeric(Object.keys(dag.nodes));
  const canonical = {
    nodes: sortedIds.map(id => [id, sortByNumeric(dag.nodes[id].dependsOn)]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Compute the ready-set: pending slices whose every dep has shipped.
 *
 * @param {object} dag — from buildDAG()
 * @param {object} sliceStates — { sliceId: "pending" | "in-progress" | "shipped" | "failed" }
 * @returns {string[]} slice ids ready to dispatch (in declaration order)
 */
export function computeReadySet(dag, sliceStates) {
  const ready = [];
  for (const sliceId of Object.keys(dag.nodes)) {
    const state = sliceStates[sliceId] ?? 'pending';
    if (state !== 'pending') continue;
    const allDepsShipped = dag.nodes[sliceId].dependsOn.every(dep => {
      return sliceStates[dep] === 'shipped';
    });
    if (allDepsShipped) ready.push(sliceId);
  }
  return ready;
}

/**
 * Deterministic first-fit non-overlap batch:
 *   For each slice in numeric order through readySet:
 *     include if Files set is disjoint from already-included Files
 *
 * @param {string[]} readySet — typically from computeReadySet()
 * @param {object} filesIndex — { sliceId: Set<string> } from buildDAG()
 * @returns {string[]} the maximal non-overlapping batch (deterministic)
 */
export function maximalFirstFitNonOverlap(readySet, filesIndex) {
  const sortedReady = sortByNumeric(readySet);
  const picked = [];
  const pickedFiles = new Set();
  for (const sliceId of sortedReady) {
    const files = filesIndex[sliceId] ?? new Set();
    let overlap = false;
    for (const f of files) {
      if (pickedFiles.has(f)) { overlap = true; break; }
    }
    if (!overlap) {
      picked.push(sliceId);
      for (const f of files) pickedFiles.add(f);
    }
  }
  return picked;
}

/**
 * Enumerate all transitive descendants of a slice (slices that depend on it,
 * directly or indirectly). Used for failure cascade halts.
 *
 * @param {object} dag
 * @param {string} sliceId — the failed slice
 * @returns {string[]} descendant slice ids in BFS order
 */
export function enumerateDescendants(dag, sliceId) {
  // Build reverse adjacency: for each slice, who depends on it?
  const reverseAdj = {};
  for (const id of Object.keys(dag.nodes)) reverseAdj[id] = [];
  for (const [id, node] of Object.entries(dag.nodes)) {
    for (const dep of node.dependsOn) {
      if (reverseAdj[dep]) reverseAdj[dep].push(id);
    }
  }
  // BFS from sliceId
  const seen = new Set([sliceId]);
  const order = [];
  const queue = [sliceId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const child of reverseAdj[cur] ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      order.push(child);
      queue.push(child);
    }
  }
  return order;
}
