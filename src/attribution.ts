/**
 * Post-processing of raw V8 profiles into per-plugin reports.
 *
 * Self-time per call-tree node = sum of `timeDeltas` at that node's sample
 * indices. Each node is bucketed by its `callFrame.url`:
 *
 *  1. `/node_modules/@scope/<pkg>/` or `/node_modules/<pkg>/` → that package
 *     (the *last* `node_modules` segment wins, to handle nested deps).
 *  2. Signal K server's own files → `signalk-server (core)`.
 *  3. `node:*` internals → `node runtime`.
 *  4. V8 synthetic frames pass through as their own rows: `(idle)`,
 *     `(garbage collector)`, `(program)`.
 */
import type { CpuBucket, CpuReport, FlameNode, HeapBucket, HeapReport } from './shared/types'

export const SIGNALK_CORE_BUCKET = 'signalk-server (core)'
export const NODE_RUNTIME_BUCKET = 'node runtime'
export const OTHER_BUCKET = '(other)'

const TOP_FUNCTIONS_LIMIT = 10
const SYNTHETIC_NAME = /^\(.+\)$/
/** Flame subtrees below this fraction of the root total are pruned. */
const FLAME_MIN_TOTAL_FRACTION = 0.001

export interface BucketOptions {
  /**
   * Absolute path of the Signal K server package root, for source checkouts
   * where the server does not live under a node_modules directory.
   */
  serverRoot?: string
}

export interface ProfileCallFrame {
  functionName: string
  url: string
  lineNumber?: number
  columnNumber?: number
}

/** Node of a standard V8 `.cpuprofile` (Profiler.stop result). */
export interface CpuProfileNode {
  id: number
  callFrame: ProfileCallFrame
  hitCount?: number
  children?: number[]
}

export interface CpuProfile {
  nodes: CpuProfileNode[]
  /** microseconds */
  startTime: number
  /** microseconds */
  endTime: number
  samples?: number[]
  /** microseconds between consecutive samples */
  timeDeltas?: number[]
}

/** Node of a V8 sampling heap profile (HeapProfiler.stopSampling result). */
export interface SamplingHeapProfileNode {
  callFrame: ProfileCallFrame
  selfSize: number
  children?: SamplingHeapProfileNode[]
}

export interface SamplingHeapProfile {
  head: SamplingHeapProfileNode
}

export function bucketForFrame(
  callFrame: Pick<ProfileCallFrame, 'functionName' | 'url'>,
  options: BucketOptions = {},
): string {
  const { url, functionName } = callFrame
  if (!url) {
    return SYNTHETIC_NAME.test(functionName) ? functionName : OTHER_BUCKET
  }

  let path = url
  if (path.startsWith('file://')) {
    path = path.slice('file://'.length)
    try {
      path = decodeURIComponent(path)
    } catch {
      // keep the undecoded path
    }
  }
  path = path.replace(/\\/g, '/')

  if (path.startsWith('node:') || path.startsWith('internal/')) {
    return NODE_RUNTIME_BUCKET
  }

  const marker = '/node_modules/'
  const markerIndex = path.lastIndexOf(marker)
  if (markerIndex !== -1) {
    const segments = path.slice(markerIndex + marker.length).split('/')
    let pkg = segments[0] ?? ''
    if (pkg.startsWith('@') && segments.length > 1) {
      pkg = `${segments[0]}/${segments[1]}`
    }
    if (!pkg) return OTHER_BUCKET
    return pkg === 'signalk-server' ? SIGNALK_CORE_BUCKET : pkg
  }

  if (options.serverRoot) {
    const root = options.serverRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    if (path === root || path.startsWith(root + '/')) {
      return SIGNALK_CORE_BUCKET
    }
  }

  return OTHER_BUCKET
}

export interface DataPathBucketOptions {
  /**
   * The Signal K config directory (e.g. ~/.signalk) — the parent of
   * plugin-config-data and node_modules on a standard install.
   */
  dataRoot?: string
  /** Same as BucketOptions.serverRoot, for source checkouts. */
  serverRoot?: string
}

/**
 * First-level config-dir entries owned by the server itself (compared
 * lowercased — older installs have e.g. `serverState`). Anything else at
 * that level is some plugin's local storage folder.
 */
const CORE_DATA_DIRS = new Set([
  'node_modules',
  'plugin-config-data',
  'serverstate',
  'applicationdata',
  'resources',
  'defaults',
  'logs',
])

/** The path relative to `root`, or null when it is not under `root`. */
function pathWithin(filePath: string, root: string | undefined): string | null {
  if (!root) return null
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized) return null
  if (filePath === normalized) return ''
  return filePath.startsWith(normalized + '/') ? filePath.slice(normalized.length + 1) : null
}

/**
 * The same attribution as `bucketForFrame`, keyed on data-file paths
 * instead of source URLs: files under `plugin-config-data/<plugin>/` belong
 * to that plugin, node_modules paths to their package, files in any other
 * first-level folder under the Signal K data root to that folder's name —
 * plugins keep local storage in folders they name themselves
 * (~/.signalk/charts-simple/…), and the folder name is the most honest
 * label available. Remaining data-root files (settings.json, serverstate/)
 * are the server core's, everything else `(other)`.
 */
export function bucketForDataPath(filePath: string, options: DataPathBucketOptions = {}): string {
  const normalized = filePath.replace(/\\/g, '/')

  const marker = '/plugin-config-data/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex !== -1) {
    const plugin = normalized.slice(markerIndex + marker.length).split('/')[0]
    if (plugin) return plugin
  }

  const packageBucket = bucketForFrame(
    { functionName: '', url: normalized },
    { serverRoot: options.serverRoot },
  )
  if (packageBucket !== OTHER_BUCKET) return packageBucket

  const withinDataRoot = pathWithin(normalized, options.dataRoot)
  if (withinDataRoot !== null) {
    // A file inside a non-core first-level folder is some plugin's local
    // storage; bucket it by the folder name (scoped names span two segments).
    const segments = withinDataRoot.split('/')
    const scoped = segments[0]?.startsWith('@') === true
    const name = scoped ? segments.slice(0, 2).join('/') : (segments[0] ?? '')
    if (
      name &&
      segments.length > (scoped ? 2 : 1) &&
      !name.startsWith('.') &&
      !CORE_DATA_DIRS.has(name.toLowerCase())
    ) {
      return name
    }
    return SIGNALK_CORE_BUCKET
  }
  return OTHER_BUCKET
}

interface FunctionAggregate {
  name: string
  url: string
  self: number
}

interface BucketAggregate {
  self: number
  functions: Map<string, FunctionAggregate>
}

function aggregateFrames(
  frames: Iterable<{ callFrame: ProfileCallFrame; self: number }>,
  options: BucketOptions,
): Map<string, BucketAggregate> {
  const buckets = new Map<string, BucketAggregate>()
  for (const { callFrame, self } of frames) {
    if (self <= 0) continue
    const bucketName = bucketForFrame(callFrame, options)
    let bucket = buckets.get(bucketName)
    if (!bucket) {
      bucket = { self: 0, functions: new Map() }
      buckets.set(bucketName, bucket)
    }
    bucket.self += self
    const fnName = callFrame.functionName || '(anonymous)'
    const fnKey = `${fnName}\u0000${callFrame.url}`
    const fn = bucket.functions.get(fnKey)
    if (fn) {
      fn.self += self
    } else {
      bucket.functions.set(fnKey, { name: fnName, url: callFrame.url, self })
    }
  }
  return buckets
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function topFunctionsOf(bucketName: string, bucket: BucketAggregate): FunctionAggregate[] | null {
  // A pure synthetic bucket ((idle), (garbage collector), ...) contains only
  // the frame it is named after — a function list adds nothing.
  if (bucket.functions.size === 1) {
    const only = bucket.functions.values().next().value as FunctionAggregate
    if (only.name === bucketName && !only.url) return null
  }
  return [...bucket.functions.values()]
    .sort((a, b) => b.self - a.self)
    .slice(0, TOP_FUNCTIONS_LIMIT)
}

function makeFlameNode(
  callFrame: ProfileCallFrame,
  self: number,
  options: BucketOptions,
): FlameNode {
  const node: FlameNode = {
    name: callFrame.functionName || '(anonymous)',
    bucket: bucketForFrame(callFrame, options),
    self: Math.round(self),
    total: Math.round(self),
  }
  if (callFrame.url) node.url = callFrame.url
  return node
}

/** Drop subtrees below `minTotal` (their cost stays in ancestors' totals) and sort siblings. */
function pruneFlame(node: FlameNode, minTotal: number): void {
  if (!node.children) return
  const kept = node.children.filter((child) => child.total >= minTotal)
  if (kept.length === 0) {
    delete node.children
    return
  }
  kept.sort((a, b) => b.total - a.total)
  node.children = kept
  for (const child of kept) pruneFlame(child, minTotal)
}

function finishFlame(root: FlameNode): FlameNode | undefined {
  if (root.total <= 0) return undefined
  pruneFlame(root, root.total * FLAME_MIN_TOTAL_FRACTION)
  return root
}

function buildCpuFlame(
  profile: CpuProfile,
  selfTimeUs: Map<number, number>,
  options: BucketOptions,
): FlameNode | undefined {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const referenced = new Set<number>()
  for (const node of profile.nodes) {
    for (const childId of node.children ?? []) referenced.add(childId)
  }

  const build = (node: CpuProfileNode): FlameNode => {
    const flame = makeFlameNode(node.callFrame, selfTimeUs.get(node.id) ?? 0, options)
    const children = (node.children ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is CpuProfileNode => child !== undefined)
      .map(build)
    if (children.length > 0) {
      flame.children = children
      flame.total = flame.self + children.reduce((sum, child) => sum + child.total, 0)
    }
    return flame
  }

  const roots = profile.nodes.filter((node) => !referenced.has(node.id)).map(build)
  const onlyRoot = roots.length === 1 ? roots[0] : undefined
  const root =
    onlyRoot !== undefined
      ? onlyRoot
      : {
          name: '(root)',
          bucket: '(root)',
          self: 0,
          total: roots.reduce((sum, child) => sum + child.total, 0),
          children: roots,
        }
  return finishFlame(root)
}

function buildHeapFlame(
  profile: SamplingHeapProfile,
  options: BucketOptions,
): FlameNode | undefined {
  const build = (node: SamplingHeapProfileNode): FlameNode => {
    const flame = makeFlameNode(node.callFrame, node.selfSize, options)
    const children = (node.children ?? []).map(build)
    if (children.length > 0) {
      flame.children = children
      flame.total = flame.self + children.reduce((sum, child) => sum + child.total, 0)
    }
    return flame
  }
  return finishFlame(build(profile.head))
}

export interface CpuReportMeta {
  id: string
  capturedAt: string
  samplingIntervalUs: number
}

export function buildCpuReport(
  profile: CpuProfile,
  meta: CpuReportMeta,
  options: BucketOptions = {},
): CpuReport {
  const selfTimeUs = new Map<number, number>()
  const samples = profile.samples ?? []
  const timeDeltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i]
    const delta = timeDeltas[i]
    // V8 occasionally emits negative deltas on clock adjustments; skip them.
    if (nodeId === undefined || typeof delta !== 'number' || delta <= 0) continue
    selfTimeUs.set(nodeId, (selfTimeUs.get(nodeId) ?? 0) + delta)
  }

  const frames = profile.nodes
    .filter((node) => selfTimeUs.has(node.id))
    .map((node) => ({ callFrame: node.callFrame, self: selfTimeUs.get(node.id) ?? 0 }))

  const aggregated = aggregateFrames(frames, options)
  const totalUs = [...aggregated.values()].reduce((sum, bucket) => sum + bucket.self, 0)

  const buckets: CpuBucket[] = [...aggregated.entries()]
    .sort((a, b) => b[1].self - a[1].self)
    .map(([name, agg]) => {
      const bucket: CpuBucket = {
        name,
        selfTimeMs: round(agg.self / 1000, 1),
        percent: totalUs > 0 ? round((100 * agg.self) / totalUs, 1) : 0,
      }
      const top = topFunctionsOf(name, agg)
      if (top) {
        bucket.topFunctions = top.map((fn) => ({
          name: fn.name,
          url: fn.url,
          selfTimeMs: round(fn.self / 1000, 1),
        }))
      }
      return bucket
    })

  const report: CpuReport = {
    id: meta.id,
    type: 'cpu',
    capturedAt: meta.capturedAt,
    durationMs: Math.round((profile.endTime - profile.startTime) / 1000),
    samplingIntervalUs: meta.samplingIntervalUs,
    totalTimeMs: round(totalUs / 1000, 1),
    buckets,
  }
  const flame = buildCpuFlame(profile, selfTimeUs, options)
  if (flame) report.flame = flame
  return report
}

export interface HeapReportMeta {
  id: string
  capturedAt: string
  durationMs: number
  samplingIntervalBytes: number
}

export function buildHeapReport(
  profile: SamplingHeapProfile,
  meta: HeapReportMeta,
  options: BucketOptions = {},
): HeapReport {
  const frames: { callFrame: ProfileCallFrame; self: number }[] = []
  const stack: SamplingHeapProfileNode[] = [profile.head]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) break
    if (node.selfSize > 0) {
      frames.push({ callFrame: node.callFrame, self: node.selfSize })
    }
    if (node.children) stack.push(...node.children)
  }

  const aggregated = aggregateFrames(frames, options)
  const totalBytes = [...aggregated.values()].reduce((sum, bucket) => sum + bucket.self, 0)

  const buckets: HeapBucket[] = [...aggregated.entries()]
    .sort((a, b) => b[1].self - a[1].self)
    .map(([name, agg]) => {
      const bucket: HeapBucket = {
        name,
        selfBytes: Math.round(agg.self),
        percent: totalBytes > 0 ? round((100 * agg.self) / totalBytes, 1) : 0,
      }
      const top = topFunctionsOf(name, agg)
      if (top) {
        bucket.topFunctions = top.map((fn) => ({
          name: fn.name,
          url: fn.url,
          selfBytes: Math.round(fn.self),
        }))
      }
      return bucket
    })

  const report: HeapReport = {
    id: meta.id,
    type: 'heap',
    capturedAt: meta.capturedAt,
    durationMs: meta.durationMs,
    samplingIntervalBytes: meta.samplingIntervalBytes,
    totalBytes: Math.round(totalBytes),
    buckets,
  }
  const flame = buildHeapFlame(profile, options)
  if (flame) report.flame = flame
  return report
}
