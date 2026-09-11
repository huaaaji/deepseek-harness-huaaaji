import { describe, expect, it } from 'vitest'
import type { GitCommitView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  buildGraph, edgePath, graphWidth, laneX, paletteColor,
  GRAPH_GEOMETRY, LANE_PALETTE,
} from '../src/client/graph.ts'
import { commitAge, matchesQuery } from '../src/client/model.ts'

/** One history window commit, for layout fixtures. */
function commit(
  hash: string,
  parents: readonly string[],
  refs: readonly GitCommitView['refs'][number][] = [],
  subject = hash,
): GitCommitView {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    refs,
    author: 'Tester',
    authorEmail: 't@t',
    authorDate: '2026-01-01T00:00:00+08:00',
    subject,
  }
}

describe('buildGraph', () => {
  it('lays a linear history on one lane with one color', () => {
    const rows = buildGraph([
      commit('c', ['b'], [{ kind: 'head', name: 'main' }, { kind: 'branch', name: 'main' }]),
      commit('b', ['a']),
      commit('a', []),
    ])
    expect(rows.map(row => row.lane)).toEqual([0, 0, 0])
    expect(rows[0]?.color).toBe(rows[1]?.color)
    expect(rows[0]?.edges).toEqual([{
      fromLane: 0, fromRow: 0, toLane: 0, toRow: 1, color: rows[0]?.color, bend: 'parent',
    }])
  })

  it('forks a branch onto its own lane and keeps the fork point on the main line', () => {
    const rows = buildGraph([
      commit('m', ['main2', 'feat'], [{ kind: 'branch', name: 'main' }], 'merge'),
      commit('feat', ['base'], [{ kind: 'branch', name: 'feature' }], 'feature tip'),
      commit('main2', ['base'], [], 'main work'),
      commit('base', []),
    ])
    const [merge, feat, main2, base] = rows
    // The continuing line (merge + first parent) sits on one lane and keeps
    // the shared ancestor; the merged tip's lane curves into it at the fork.
    expect(merge?.lane).toBe(0)
    expect(main2?.lane).toBe(0)
    expect(base?.lane).toBe(0)
    expect(feat?.lane).toBe(1)
    expect(feat?.color).not.toBe(merge?.color)
    expect(merge?.edges).toEqual([
      { fromLane: 0, fromRow: 0, toLane: 0, toRow: 2, color: merge?.color, bend: 'parent' },
      { fromLane: 0, fromRow: 0, toLane: 1, toRow: 1, color: feat?.color, bend: 'child' },
    ])
    // The fork point feeds both lines: the base row inherits the main color.
    expect(base?.color).toBe(merge?.color)
    // Branch names follow the lanes: the main line and its fork point carry
    // `main`; the merged line carries `feature`.
    expect(merge?.branchName).toBe('main')
    expect(main2?.branchName).toBe('main')
    expect(base?.branchName).toBe('main')
    expect(feat?.branchName).toBe('feature')
  })

  it('inherits the first child color for unrefined commits', () => {
    const rows = buildGraph([
      commit('tip', ['mid'], [{ kind: 'branch', name: 'main' }]),
      commit('mid', ['base']),
      commit('base', []),
    ])
    expect(rows[0]?.color).toBe(rows[1]?.color)
    expect(rows[1]?.color).toBe(rows[2]?.color)
    expect(rows[1]?.branchName).toBe('main')
    expect(rows[2]?.branchName).toBe('main')
  })

  it('gives a root window commit without refs an anonymous color', () => {
    const rows = buildGraph([commit('orphan', [])])
    expect(rows[0]?.color).toBe(0)
    expect(rows[0]?.branchName).toBeNull()
    expect(rows[0]?.edges).toEqual([])
  })

  it('omits edges to parents outside the window', () => {
    const rows = buildGraph([
      commit('tip', ['unloaded'], [{ kind: 'branch', name: 'main' }]),
    ])
    expect(rows[0]?.edges).toEqual([])
  })

  it('assigns remote refs their own lane and color', () => {
    const rows = buildGraph([
      commit('local', ['base'], [{ kind: 'branch', name: 'main' }]),
      commit('remote', ['base'], [{ kind: 'remote', name: 'origin/main' }]),
      commit('base', []),
    ])
    expect(rows[0]?.lane).not.toBe(rows[1]?.lane)
    expect(rows[0]?.color).not.toBe(rows[1]?.color)
  })
})

describe('edgePath', () => {
  it('draws a straight vertical for same-lane connectors', () => {
    const path = edgePath({ fromLane: 2, fromRow: 0, toLane: 2, toRow: 3, color: 0, bend: 'parent' })
    const x = laneX(2)
    expect(path).toBe(`M ${x} 21 V ${(3 * 34 + 17) - 4}`)
  })

  it('bends a first-parent connector near the parent row', () => {
    // fromRow 0 (dot bottom y=21) to toRow 2 (dot top y=81): dy=60, bend=14.
    const path = edgePath({ fromLane: 0, fromRow: 0, toLane: 2, toRow: 2, color: 0, bend: 'parent' })
    expect(path).toBe(`M ${laneX(0)} 21 V 67 C ${laneX(0)} 74, ${laneX(2)} 74, ${laneX(2)} 67 V 81`)
  })

  it('bends a merge connector near the child row, running up the parent lane', () => {
    // The long vertical rides the parent's lane (lane 2), the curve sits just
    // below the child's dot — Git Graph's merge layout.
    const path = edgePath({ fromLane: 0, fromRow: 0, toLane: 2, toRow: 2, color: 0, bend: 'child' })
    expect(path).toBe(`M ${laneX(2)} 81 V 49 C ${laneX(2)} 42, ${laneX(0)} 42, ${laneX(0)} 35 V 21`)
  })

  it('shrinks the bend for adjacent rows instead of overshooting', () => {
    // Adjacent rows: dy = 26, so the bend clamps to dy/3 and every y stays
    // inside the two dot anchors (21..47).
    const bend = 26 / 3
    const path = edgePath({ fromLane: 0, fromRow: 0, toLane: 1, toRow: 1, color: 0, bend: 'child' })
    expect(path).toBe(
      `M ${laneX(1)} 47 V ${21 + 2 * bend} C ${laneX(1)} ${21 + 1.5 * bend}, ${laneX(0)} ${21 + 1.5 * bend}, ${laneX(0)} ${21 + bend} V 21`,
    )
  })
})

describe('graph geometry helpers', () => {
  it('computes lane centers, palette wraps, and overlay width', () => {
    expect(laneX(0)).toBe(GRAPH_GEOMETRY.paddingLeft + GRAPH_GEOMETRY.dotRadius)
    expect(laneX(1)).toBe(laneX(0) + GRAPH_GEOMETRY.laneWidth)
    expect(paletteColor(0)).toBe(LANE_PALETTE[0])
    expect(paletteColor(LANE_PALETTE.length + 1)).toBe(LANE_PALETTE[1])
    expect(graphWidth(2)).toBeGreaterThan(laneX(2))
  })
})

describe('matchesQuery', () => {
  const row = commit('a'.repeat(40), [], [{ kind: 'branch', name: 'feature/panel' }], 'Fix the Panel')

  it('matches subject, hash, author, and ref names case-insensitively', () => {
    expect(matchesQuery(row, 'panel')).toBe(true)
    expect(matchesQuery(row, 'FEATURE')).toBe(true)
    expect(matchesQuery(row, 'tester')).toBe(true)
    expect(matchesQuery(row, 'a'.repeat(10))).toBe(true)
  })

  it('rejects unrelated queries and accepts an empty one', () => {
    expect(matchesQuery(row, 'nothing')).toBe(false)
    expect(matchesQuery(row, '  ')).toBe(true)
  })
})

describe('commitAge', () => {
  const now = Date.parse('2026-01-01T12:00:00+08:00')

  it('buckets fresh, hourly, and daily ages', () => {
    expect(commitAge('2026-01-01T11:59:30+08:00', now)).toEqual({ unit: 'minutes', value: 0 })
    expect(commitAge('2026-01-01T11:30:00+08:00', now)).toEqual({ unit: 'minutes', value: 30 })
    expect(commitAge('2026-01-01T09:00:00+08:00', now)).toEqual({ unit: 'hours', value: 3 })
    expect(commitAge('2025-12-30T09:00:00+08:00', now)).toEqual({ unit: 'days', value: 2 })
  })

  it('falls back to the date for old or unparsable dates', () => {
    expect(commitAge('2025-01-01T09:00:00+08:00', now)).toEqual({ unit: 'date', value: '2025-01-01' })
    expect(commitAge('not-a-date', now)).toEqual({ unit: 'date', value: 'not-a-date' })
  })
})
