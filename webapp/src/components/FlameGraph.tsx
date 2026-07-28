import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FlameNode, ProfileType } from '../../../src/shared/types'
import { formatBytes, formatMs } from '../format'

/**
 * Flame graph (icicle, root at top) rendered as plain positioned divs —
 * width ∝ total time/bytes of the frame within the zoomed view. Click a
 * frame to zoom to it, click an ancestor (or Reset) to zoom back out.
 *
 * Frames are colored by attribution bucket. The four hues validated
 * against this app's light surface for arbitrary adjacency (all-pairs
 * CVD ΔE ≥ 8, normal ≥ 15) cover signalk core and the top packages;
 * every other bucket folds into neutral grays. Identity never rides on
 * color alone: wide frames carry their name, and every frame has a
 * tooltip (hover and keyboard focus) plus the bucket table below.
 */

const ROW_HEIGHT = 20
/** Frames narrower than this % of the view are not rendered. */
const MIN_WIDTH_PCT = 0.08
/** Conservative glyph width at 11px system-ui, for the label-fits check. */
const CHAR_WIDTH = 6.6
const LABEL_PADDING = 10

const CORE_BUCKET = 'signalk-server (core)'
const SYNTHETIC = /^\(.+\)$/

/** Slot order is the CVD-safety mechanism — never reshuffled or cycled. */
const HUE_SLOTS = ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7']
/** Fills whose labels need white text; the rest take dark ink. */
const DARK_FILLS = new Set(['#4a3aa7'])
const IDLE_FILL = '#f0efec'
const SYSTEM_FILL = '#c3c2b7'
const FOLDED_FILL = '#898781'

interface Frame {
  node: FlameNode
  depth: number
  /** percent of the view */
  left: number
  /** percent of the view */
  width: number
  /** true for ancestors of the zoomed frame, drawn dimmed at full width */
  context: boolean
}

function pathTo(root: FlameNode, target: FlameNode): FlameNode[] {
  if (root === target) return [root]
  for (const child of root.children ?? []) {
    const path = pathTo(child, target)
    if (path.length > 0) return [root, ...path]
  }
  return []
}

function selfByBucket(root: FlameNode): Map<string, number> {
  const sums = new Map<string, number>()
  const walk = (node: FlameNode) => {
    sums.set(node.bucket, (sums.get(node.bucket) ?? 0) + node.self)
    node.children?.forEach(walk)
  }
  walk(root)
  return sums
}

/**
 * Hue slots go to code buckets by self weight, signalk core pinned to
 * blue so it reads the same in every report. Synthetic frames, the node
 * runtime, and buckets past the last slot stay neutral.
 */
function assignHues(root: FlameNode): {
  hues: Map<string, string>
  hasFolded: boolean
  hasIdle: boolean
} {
  const sums = selfByBucket(root)
  const eligible = [...sums.entries()]
    .filter(([name]) => !SYNTHETIC.test(name) && name !== 'node runtime')
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
  const hues = new Map<string, string>()
  const slots = [...HUE_SLOTS]
  if (eligible.includes(CORE_BUCKET)) {
    hues.set(CORE_BUCKET, slots.shift() ?? '')
  }
  for (const name of eligible) {
    if (slots.length === 0) break
    if (!hues.has(name)) hues.set(name, slots.shift() ?? '')
  }
  return {
    hues,
    hasFolded: eligible.some((name) => !hues.has(name)),
    hasIdle: sums.has('(idle)'),
  }
}

function fillFor(bucket: string, hues: Map<string, string>): string {
  const hue = hues.get(bucket)
  if (hue) return hue
  if (bucket === '(idle)') return IDLE_FILL
  if (SYNTHETIC.test(bucket) || bucket === 'node runtime') return SYSTEM_FILL
  return FOLDED_FILL
}

export function FlameGraph({ root, type }: { root: FlameNode; type: ProfileType }) {
  const [focus, setFocus] = useState<FlameNode>(root)
  const [tooltip, setTooltip] = useState<{ frame: Frame; x: number; y: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setContainerWidth(el.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const { hues, hasFolded, hasIdle } = useMemo(() => assignHues(root), [root])

  const frames = useMemo(() => {
    const chain = pathTo(root, focus)
    const path = chain.length > 0 ? chain : [root]
    const view = path[path.length - 1] ?? root
    const list: Frame[] = path.map((node, depth) => ({
      node,
      depth,
      left: 0,
      width: 100,
      context: node !== view,
    }))
    const pushChildren = (parent: FlameNode, depth: number, left: number, width: number) => {
      let x = left
      for (const child of parent.children ?? []) {
        const childWidth = (child.total / parent.total) * width
        if (childWidth >= MIN_WIDTH_PCT) {
          list.push({ node: child, depth, left: x, width: childWidth, context: false })
          pushChildren(child, depth + 1, x, childWidth)
        }
        x += childWidth
      }
    }
    pushChildren(view, path.length, 0, 100)
    return list
  }, [root, focus])

  const rows = frames.reduce((max, frame) => Math.max(max, frame.depth + 1), 1)
  const formatValue = type === 'cpu' ? (value: number) => formatMs(value / 1e6) : formatBytes

  const percentOf = (value: number, of: number) => ((100 * value) / Math.max(of, 1)).toFixed(1)

  const frameLabel = (frame: Frame) => {
    const { node } = frame
    return `${node.name} — ${node.bucket} — ${formatValue(node.total)} (${percentOf(node.total, root.total)}% of capture)`
  }

  const showTooltipAt = (frame: Frame, x: number, y: number) => {
    const width = containerRef.current?.clientWidth ?? 0
    setTooltip({ frame, x: Math.max(0, Math.min(x, width - 280)), y })
  }

  const legend: [string, string][] = [
    ...hues.entries(),
    ...(hasFolded ? [['other packages', FOLDED_FILL] as [string, string]] : []),
    ['runtime & system', SYSTEM_FILL] as [string, string],
    ...(hasIdle ? [['(idle)', IDLE_FILL] as [string, string]] : []),
  ]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-base-content/70">
        {legend.map(([bucket, fill]) => (
          <span key={bucket} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-[3px] border border-base-300"
              style={{ backgroundColor: fill }}
            />
            {bucket}
          </span>
        ))}
        {focus !== root ? (
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setFocus(root)}>
            Reset zoom
          </button>
        ) : null}
      </div>
      <div
        ref={containerRef}
        role="group"
        aria-label="Flame graph"
        className="relative max-h-96 overflow-x-hidden overflow-y-auto"
        onMouseLeave={() => setTooltip(null)}
      >
        <div className="relative" style={{ height: rows * ROW_HEIGHT }}>
          {frames.map((frame) => {
            const { node } = frame
            const fill = fillFor(node.bucket, hues)
            const pixelWidth = (frame.width / 100) * containerWidth
            const labelFits =
              pixelWidth - LABEL_PADDING >= node.name.length * CHAR_WIDTH && !frame.context
            return (
              <button
                key={`${frame.depth}:${frame.left.toFixed(3)}:${node.name}`}
                type="button"
                data-testid="flame-frame"
                aria-label={frameLabel(frame)}
                className={`absolute cursor-pointer overflow-hidden rounded-[3px] border border-base-100 text-left text-[11px] leading-[18px] whitespace-nowrap hover:brightness-105 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-base-content ${
                  frame.context ? 'opacity-60' : ''
                }`}
                style={{
                  top: frame.depth * ROW_HEIGHT,
                  left: `${Number(frame.left.toFixed(3))}%`,
                  width: `${Number(frame.width.toFixed(3))}%`,
                  height: ROW_HEIGHT,
                  backgroundColor: fill,
                  color: DARK_FILLS.has(fill) ? '#ffffff' : '#0b0b0b',
                }}
                onClick={() => setFocus(node)}
                onMouseMove={(event) => {
                  const rect = containerRef.current?.getBoundingClientRect()
                  showTooltipAt(
                    frame,
                    event.clientX - (rect?.left ?? 0) + 10,
                    event.clientY - (rect?.top ?? 0) + 14,
                  )
                }}
                onFocus={() => {
                  showTooltipAt(
                    frame,
                    (frame.left / 100) * containerWidth,
                    (frame.depth + 1) * ROW_HEIGHT + 2,
                  )
                }}
                onBlur={() => setTooltip(null)}
              >
                {labelFits ? <span className="px-1">{node.name}</span> : null}
              </button>
            )
          })}
          {tooltip ? (
            <div
              className="pointer-events-none absolute z-20 w-max max-w-[280px] rounded border border-base-300 bg-base-100 p-2 text-xs shadow-md"
              style={{ left: tooltip.x, top: tooltip.y }}
              role="status"
            >
              <p className="font-semibold tabular-nums">
                {formatValue(tooltip.frame.node.total)} ·{' '}
                {tooltip.frame.context
                  ? null
                  : `${percentOf(tooltip.frame.node.total, focus.total)}% of view · `}
                {percentOf(tooltip.frame.node.total, root.total)}% of capture
              </p>
              <p className="break-all">
                <code>{tooltip.frame.node.name}</code>
              </p>
              <p className="flex items-center gap-1.5 text-base-content/70">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: fillFor(tooltip.frame.node.bucket, hues) }}
                />
                {tooltip.frame.node.bucket} · self {formatValue(tooltip.frame.node.self)}
              </p>
              {tooltip.frame.node.url ? (
                <p className="break-all text-base-content/60">{tooltip.frame.node.url}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
