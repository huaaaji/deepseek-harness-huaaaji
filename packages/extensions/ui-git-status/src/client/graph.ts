/** Pure DAG layout for the history tab: branch coloring, lane assignment, and SVG edge paths. */

import type { GitCommitView } from '@deepseek-ai/dsh-api-remotes/client'

/** Fixed geometry shared by the SVG renderer and the path builder (all px). */
export const GRAPH_GEOMETRY = {
  rowHeight: 34,
  laneWidth: 20,
  dotRadius: 4,
  bend: 14,
  paddingLeft: 14,
} as const

/** Git Graph's default lane palette, in stable order. */
export const LANE_PALETTE = [
  '#0085d9', '#d97a00', '#a900d9', '#00a0a0', '#d90000',
  '#5d5d00', '#8d5dd9', '#009828',
] as const

/** One rendered graph row (newest first, row 0 at the top). */
export interface GraphRow {
  readonly commit: GitCommitView
  /** 0-based lane index from the left. */
  readonly lane: number
  /** Palette index of this commit's branch color. */
  readonly color: number
  /** The named branch this row's lane belongs to, or null for an anonymous
   * line (commits reachable from no ref). Matches the wire branch names, so
   * the details panel can highlight the graph-owned chip. */
  readonly branchName: string | null
  /** Connectors to parents inside the window, in git parent order. */
  readonly edges: readonly GraphEdge[]
  /** 0-based row index within the laid-out window. */
  readonly row: number
}

/** One connector the SVG overlay strokes. */
export interface GraphEdge {
  readonly fromLane: number
  readonly fromRow: number
  readonly toLane: number
  readonly toRow: number
  /** Palette index the segment is stroked with. */
  readonly color: number
  /**
   * Where the cross-lane S-curve sits: first-parent (fork) connectors bend
   * near the parent, so a branch line runs down its own lane and joins the
   * fork point; merge-in connectors bend near the child, so the merged
   * branch runs straight up its lane and curves into the merge commit —
   * Git Graph's layout.
   */
  readonly bend: 'parent' | 'child'
}

/** The dot's center x for one lane. */
export function laneX(lane: number): number {
  return GRAPH_GEOMETRY.paddingLeft + GRAPH_GEOMETRY.dotRadius + lane * GRAPH_GEOMETRY.laneWidth
}

/**
 * Lay out one commit window into graph rows.
 *
 * Branch coloring: a commit with a branch/remote ref starts that ref's color;
 * otherwise it inherits the color of its first child in the window, and a
 * commit with no inheritable ancestry gets an anonymous color. Lanes are
 * allocated leftmost-free and freed when a branch's oldest window commit is
 * placed, so a merged branch's lane ends at its tip while the merge commit
 * keeps the continuing branch's lane.
 *
 * Parents outside the window produce no edge: the connector simply ends at
 * the window boundary (the next page continues the history).
 * @param commits - history window, newest first (usually one page).
 * @returns one row per commit, in the same order.
 */
export function buildGraph(commits: readonly GitCommitView[]): readonly GraphRow[] {
  const byHash = new Map<string, GitCommitView>()
  for (const commit of commits) byHash.set(commit.hash, commit)

  // Children in window order: the first child of a commit is its first
  // child in newest-first order (the one that inherits the color downward).
  const children = new Map<string, GitCommitView[]>()
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (!byHash.has(parent)) continue
      const list = children.get(parent)
      if (list === undefined) children.set(parent, [commit])
      else list.push(commit)
    }
  }

  // The first-parent chain from the newest commit carries the "continuing"
  // line: a fork point inherits a marked child first, so the main line keeps
  // the shared ancestor and merged-in lines curve into it (gitk's layout).
  const firstParentMarked = new Set<string>()
  let cursor = commits[0]
  while (cursor !== undefined) {
    firstParentMarked.add(cursor.hash)
    const parent = cursor.parents[0]
    cursor = parent === undefined ? undefined : byHash.get(parent)
  }

  // Pass 1: branch id + color per commit.
  const branchOf = new Map<string, string>()
  const branchColor = new Map<string, number>()
  let nextColor = 0
  let anonCount = 0
  for (const commit of commits) {
    const branchRef = commit.refs.find(ref => ref.kind === 'branch' || ref.kind === 'remote')
    let branch: string
    if (branchRef !== undefined) {
      branch = `ref:${branchRef.name}`
    } else {
      const markedChild = children.get(commit.hash)?.find(child => firstParentMarked.has(child.hash))
      const firstChild = markedChild ?? children.get(commit.hash)?.[0]
      const inherited = firstChild === undefined ? undefined : branchOf.get(firstChild.hash)
      if (inherited !== undefined) {
        branch = inherited
      } else {
        branch = `~anon:${anonCount}`
        anonCount += 1
      }
    }
    branchOf.set(commit.hash, branch)
    const color = branchColor.get(branch) ?? nextColor
    if (!branchColor.has(branch)) {
      branchColor.set(branch, color)
      nextColor += 1
    }
  }

  // Count after assignment: inheritance may move a commit off its first
  // child's branch, so counting during assignment would overcount lanes.
  const branchCount = new Map<string, number>()
  for (const commit of commits) {
    const branch = branchOf.get(commit.hash) ?? '~anon:fallback'
    branchCount.set(branch, (branchCount.get(branch) ?? 0) + 1)
  }

  // Pass 2: lane assignment, newest first.
  const laneOfBranch = new Map<string, number>()
  const takenLanes: number[] = []
  const rows: MutableRow[] = []
  const rowOf = new Map<string, number>()
  commits.forEach((commit, index) => {
    const branch = branchOf.get(commit.hash) ?? '~anon:fallback'
    const existing = laneOfBranch.get(branch)
    const lane = existing ?? smallestFreeLane(takenLanes)
    if (existing === undefined) {
      takenLanes.push(lane)
      laneOfBranch.set(branch, lane)
    }
    rowOf.set(commit.hash, index)
    rows.push({
      commit,
      lane,
      color: branchColor.get(branch) ?? 0,
      branchName: branch.startsWith('ref:') ? branch.slice('ref:'.length) : null,
      row: index,
      edges: [],
    })
    const remaining = (branchCount.get(branch) ?? 1) - 1
    if (remaining <= 0) {
      laneOfBranch.delete(branch)
      takenLanes.splice(takenLanes.indexOf(lane), 1)
    } else {
      branchCount.set(branch, remaining)
    }
  })

  // Pass 3: parent connectors. The first-parent segment keeps the commit's
  // color and bends near the parent (fork layout); merge-in segments take the
  // merged parent's color and bend near the child (merge layout).
  for (const row of rows) {
    const edges: GraphEdge[] = []
    row.commit.parents.forEach((parentHash, parentIndex) => {
      const toRow = rowOf.get(parentHash)
      if (toRow === undefined) return
      const target = rows[toRow]
      if (target === undefined) return
      edges.push({
        fromLane: row.lane,
        fromRow: row.row,
        toLane: target.lane,
        toRow,
        color: parentIndex === 0 ? row.color : target.color,
        bend: parentIndex === 0 ? 'parent' : 'child',
      })
    })
    row.edges = edges
  }

  return rows
}

/** Smallest non-negative lane index not present in the sorted taken list. */
function smallestFreeLane(takenLanes: readonly number[]): number {
  for (let lane = 0; ; lane += 1) {
    if (!takenLanes.includes(lane)) return lane
  }
}

/**
 * SVG path data for one connector (dot-center to dot-center). Same-lane edges
 * are straight verticals; cross-lane edges are an S-curve whose bend shrinks
 * when the rows are adjacent so the curve never overshoots either dot.
 */
export function edgePath(edge: GraphEdge): string {
  const x0 = laneX(edge.fromLane)
  const x1 = laneX(edge.toLane)
  const y0 = edge.fromRow * GRAPH_GEOMETRY.rowHeight + GRAPH_GEOMETRY.rowHeight / 2 + GRAPH_GEOMETRY.dotRadius
  const y1 = edge.toRow * GRAPH_GEOMETRY.rowHeight + GRAPH_GEOMETRY.rowHeight / 2 - GRAPH_GEOMETRY.dotRadius
  if (edge.fromLane === edge.toLane) return `M ${x0} ${y0} V ${y1}`
  const dy = y1 - y0
  const bend = Math.min(GRAPH_GEOMETRY.bend, dy / 3)
  if (edge.bend === 'parent') {
    const bendLow = y1 - bend
    return `M ${x0} ${y0} V ${bendLow} C ${x0} ${y1 - bend / 2}, ${x1} ${y1 - bend / 2}, ${x1} ${bendLow} V ${y1}`
  }
  const bendHigh = y0 + bend
  const bendLow = y0 + 2 * bend
  return `M ${x1} ${y1} V ${bendLow} C ${x1} ${y0 + 1.5 * bend}, ${x0} ${y0 + 1.5 * bend}, ${x0} ${bendHigh} V ${y0}`
}

/** One row's dot center y. */
export function dotY(row: number): number {
  return row * GRAPH_GEOMETRY.rowHeight + GRAPH_GEOMETRY.rowHeight / 2
}

/** Palette color for a palette index (wraps past the palette end). */
export function paletteColor(color: number): string {
  return LANE_PALETTE[color % LANE_PALETTE.length] ?? LANE_PALETTE[0]
}

/** The SVG overlay's minimum width for the widest lane. */
export function graphWidth(maxLane: number): number {
  return laneX(maxLane) + GRAPH_GEOMETRY.dotRadius + GRAPH_GEOMETRY.laneWidth
}

interface MutableRow {
  readonly commit: GitCommitView
  readonly lane: number
  readonly color: number
  readonly branchName: string | null
  readonly row: number
  edges: GraphEdge[]
}
