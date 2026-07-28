import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bucketForFrame,
  buildCpuReport,
  buildHeapReport,
  NODE_RUNTIME_BUCKET,
  OTHER_BUCKET,
  SIGNALK_CORE_BUCKET,
  type CpuProfile,
  type SamplingHeapProfile,
} from '../src/attribution'

const frame = (url: string, functionName = 'fn') => ({ url, functionName })

describe('bucketForFrame', () => {
  it('buckets plain packages under node_modules', () => {
    expect(
      bucketForFrame(frame('/home/pi/.signalk/node_modules/signalk-derived-data/index.js')),
    ).toBe('signalk-derived-data')
  })

  it('buckets scoped packages with both segments', () => {
    expect(
      bucketForFrame(frame('/home/pi/.signalk/node_modules/@signalk/aisreporter/dist/index.js')),
    ).toBe('@signalk/aisreporter')
  })

  it('takes the last node_modules segment for nested dependencies', () => {
    expect(
      bucketForFrame(
        frame('/home/pi/.signalk/node_modules/plugin-a/node_modules/lodash/lodash.js'),
      ),
    ).toBe('lodash')
  })

  it('resolves pnpm-style virtual store paths to the real package', () => {
    expect(
      bucketForFrame(
        frame('/repo/node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js'),
      ),
    ).toBe('lodash')
  })

  it('handles file:// URLs', () => {
    expect(bucketForFrame(frame('file:///usr/lib/node_modules/signalk-tides/dist/index.js'))).toBe(
      'signalk-tides',
    )
  })

  it('decodes percent-encoded file URLs', () => {
    expect(bucketForFrame(frame('file:///home/pi/My%20Boat/node_modules/foo/index.js'))).toBe('foo')
  })

  it('handles Windows-style backslash paths', () => {
    expect(bucketForFrame(frame('C:\\Users\\bob\\signalk\\node_modules\\foo\\index.js'))).toBe(
      'foo',
    )
  })

  it('maps the signalk-server package to the core bucket', () => {
    expect(bucketForFrame(frame('file:///usr/lib/node_modules/signalk-server/lib/deltas.js'))).toBe(
      SIGNALK_CORE_BUCKET,
    )
  })

  it('maps files under a configured serverRoot to the core bucket', () => {
    const options = { serverRoot: '/home/user/src/signalk-server' }
    expect(bucketForFrame(frame('/home/user/src/signalk-server/lib/index.js'), options)).toBe(
      SIGNALK_CORE_BUCKET,
    )
    expect(bucketForFrame(frame('/home/user/src/other-project/lib/index.js'), options)).toBe(
      OTHER_BUCKET,
    )
  })

  it('prefers the node_modules rule over serverRoot for plugins inside the server tree', () => {
    const options = { serverRoot: '/home/user/src/signalk-server' }
    expect(
      bucketForFrame(frame('/home/user/src/signalk-server/node_modules/foo/index.js'), options),
    ).toBe('foo')
  })

  it('maps node: internals to the node runtime bucket', () => {
    expect(bucketForFrame(frame('node:fs/promises'))).toBe(NODE_RUNTIME_BUCKET)
    expect(bucketForFrame(frame('node:events'))).toBe(NODE_RUNTIME_BUCKET)
    expect(bucketForFrame(frame('internal/process/task_queues.js'))).toBe(NODE_RUNTIME_BUCKET)
  })

  it('passes V8 synthetic frames through as their own rows', () => {
    for (const name of ['(idle)', '(garbage collector)', '(program)', '(root)']) {
      expect(bucketForFrame(frame('', name))).toBe(name)
    }
  })

  it('buckets url-less non-synthetic frames as other', () => {
    expect(bucketForFrame(frame('', ''))).toBe(OTHER_BUCKET)
    expect(bucketForFrame(frame('', 'someEvalFn'))).toBe(OTHER_BUCKET)
  })

  it('buckets non-server files outside node_modules as other', () => {
    expect(bucketForFrame(frame('/home/pi/scripts/tool.js'))).toBe(OTHER_BUCKET)
  })
})

describe('buildCpuReport', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'sample.cpuprofile'), 'utf8'),
  ) as CpuProfile
  const meta = { id: 'cpu-test', capturedAt: '2026-07-28T00:00:00.000Z', samplingIntervalUs: 1000 }

  it('aggregates self time per bucket from samples and timeDeltas', () => {
    const report = buildCpuReport(fixture, meta)
    const byName = Object.fromEntries(report.buckets.map((b) => [b.name, b]))

    expect(byName['(idle)'].selfTimeMs).toBe(6)
    expect(byName['(idle)'].percent).toBe(30)
    expect(byName[SIGNALK_CORE_BUCKET].selfTimeMs).toBe(5)
    expect(byName[SIGNALK_CORE_BUCKET].percent).toBe(25)
    expect(byName['signalk-derived-data'].selfTimeMs).toBe(2)
    expect(byName['@signalk/aisreporter'].selfTimeMs).toBe(1)
    expect(byName['lodash'].selfTimeMs).toBe(1)
    expect(byName[NODE_RUNTIME_BUCKET].selfTimeMs).toBe(1)
    expect(byName[OTHER_BUCKET].selfTimeMs).toBe(1)
    expect(byName['(garbage collector)'].selfTimeMs).toBe(2)
    expect(byName['(program)'].selfTimeMs).toBe(1)
  })

  it('sorts buckets by self time descending and sums percents to ~100', () => {
    const report = buildCpuReport(fixture, meta)
    const selfTimes = report.buckets.map((b) => b.selfTimeMs)
    expect(selfTimes).toEqual([...selfTimes].sort((a, b) => b - a))
    const totalPercent = report.buckets.reduce((sum, b) => sum + b.percent, 0)
    expect(totalPercent).toBeCloseTo(100, 1)
    expect(report.totalTimeMs).toBe(20)
    expect(report.durationMs).toBe(20)
  })

  it('lists top functions by self time within a bucket', () => {
    const report = buildCpuReport(fixture, meta)
    const core = report.buckets.find((b) => b.name === SIGNALK_CORE_BUCKET)
    expect(core?.topFunctions).toEqual([
      {
        name: 'processDeltas',
        url: 'file:///usr/lib/node_modules/signalk-server/lib/deltas.js',
        selfTimeMs: 3,
      },
      {
        name: 'buildFullFromDeltas',
        url: 'file:///usr/lib/node_modules/signalk-server/lib/fullsignalk.js',
        selfTimeMs: 2,
      },
    ])
  })

  it('names anonymous functions and omits function lists for synthetic buckets', () => {
    const report = buildCpuReport(fixture, meta)
    const idle = report.buckets.find((b) => b.name === '(idle)')
    expect(idle?.topFunctions).toBeUndefined()
    const other = report.buckets.find((b) => b.name === OTHER_BUCKET)
    expect(other?.topFunctions?.[0].name).toBe('(anonymous)')
  })

  it('caps top functions at 10 per bucket', () => {
    const nodes = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      callFrame: { functionName: `fn${i}`, url: `/x/node_modules/pkg/f${i}.js` },
    }))
    const profile: CpuProfile = {
      nodes,
      startTime: 0,
      endTime: 15000,
      samples: nodes.map((n) => n.id),
      timeDeltas: nodes.map(() => 1000),
    }
    const report = buildCpuReport(profile, meta)
    expect(report.buckets).toHaveLength(1)
    expect(report.buckets[0].topFunctions).toHaveLength(10)
  })

  it('ignores negative and missing time deltas', () => {
    const profile: CpuProfile = {
      nodes: [{ id: 1, callFrame: { functionName: 'f', url: '/x/node_modules/pkg/i.js' } }],
      startTime: 0,
      endTime: 3000,
      samples: [1, 1, 1],
      timeDeltas: [1000, -500],
    }
    const report = buildCpuReport(profile, meta)
    expect(report.buckets[0].selfTimeMs).toBe(1)
  })

  it('handles an empty profile without dividing by zero', () => {
    const profile: CpuProfile = { nodes: [], startTime: 0, endTime: 0, samples: [], timeDeltas: [] }
    const report = buildCpuReport(profile, meta)
    expect(report.buckets).toEqual([])
    expect(report.totalTimeMs).toBe(0)
  })

  it('carries capture metadata into the report', () => {
    const report = buildCpuReport(fixture, meta)
    expect(report.id).toBe('cpu-test')
    expect(report.type).toBe('cpu')
    expect(report.capturedAt).toBe('2026-07-28T00:00:00.000Z')
    expect(report.samplingIntervalUs).toBe(1000)
  })
})

describe('buildHeapReport', () => {
  const heapProfile: SamplingHeapProfile = {
    head: {
      callFrame: { functionName: '(root)', url: '' },
      selfSize: 0,
      children: [
        {
          callFrame: {
            functionName: 'allocateBuffers',
            url: '/home/pi/.signalk/node_modules/plugin-x/index.js',
          },
          selfSize: 2048,
          children: [
            {
              callFrame: { functionName: 'concat', url: 'node:buffer' },
              selfSize: 1024,
              children: [],
            },
          ],
        },
        {
          callFrame: {
            functionName: 'makeStrings',
            url: 'file:///usr/lib/node_modules/signalk-server/lib/x.js',
          },
          selfSize: 1024,
          children: [],
        },
      ],
    },
  }
  const meta = {
    id: 'heap-test',
    capturedAt: '2026-07-28T00:00:00.000Z',
    durationMs: 10000,
    samplingIntervalBytes: 32768,
  }

  it('aggregates self sizes across the tree with the same bucketing', () => {
    const report = buildHeapReport(heapProfile, meta)
    const byName = Object.fromEntries(report.buckets.map((b) => [b.name, b]))
    expect(byName['plugin-x'].selfBytes).toBe(2048)
    expect(byName['plugin-x'].percent).toBe(50)
    expect(byName[NODE_RUNTIME_BUCKET].selfBytes).toBe(1024)
    expect(byName[SIGNALK_CORE_BUCKET].selfBytes).toBe(1024)
    expect(report.totalBytes).toBe(4096)
    expect(report.type).toBe('heap')
    expect(report.durationMs).toBe(10000)
    expect(report.samplingIntervalBytes).toBe(32768)
  })

  it('includes top functions per bucket by self size', () => {
    const report = buildHeapReport(heapProfile, meta)
    const pluginX = report.buckets.find((b) => b.name === 'plugin-x')
    expect(pluginX?.topFunctions).toEqual([
      {
        name: 'allocateBuffers',
        url: '/home/pi/.signalk/node_modules/plugin-x/index.js',
        selfBytes: 2048,
      },
    ])
  })
})
