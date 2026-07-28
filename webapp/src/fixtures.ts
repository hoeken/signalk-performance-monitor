/** Fixture API responses for component tests. */
import type {
  CpuReport,
  HeapReport,
  MetricsSnapshot,
  ProfileListResponse,
} from '../../src/shared/types'

export const metricsFixture: MetricsSnapshot = {
  timestamp: '2026-07-28T10:15:30.000Z',
  eventLoopDelay: { p50: 0.0021, p99: 0.0123, max: 0.0405 },
  eventLoopUtilization: 0.42,
  gcPauseTime: 0.0031,
  memory: { heapUsed: 88_300_544, rss: 156_237_824 },
  cpuUtilization: 0.37,
}

export const cpuReportFixture: CpuReport = {
  id: 'cpu-2026-07-28T10-00-00-000Z',
  type: 'cpu',
  capturedAt: '2026-07-28T10:00:00.000Z',
  durationMs: 30000,
  samplingIntervalUs: 1000,
  totalTimeMs: 30000,
  buckets: [
    { name: '(idle)', selfTimeMs: 18360, percent: 61.2 },
    {
      name: 'signalk-server (core)',
      selfTimeMs: 5220,
      percent: 17.4,
      topFunctions: [
        {
          name: 'buildFullFromDeltas',
          url: 'file:///usr/lib/node_modules/signalk-server/lib/fullsignalk.js',
          selfTimeMs: 3100,
        },
        {
          name: 'processDeltas',
          url: 'file:///usr/lib/node_modules/signalk-server/lib/deltas.js',
          selfTimeMs: 2120,
        },
      ],
    },
    {
      name: 'signalk-derived-data',
      selfTimeMs: 4200,
      percent: 14,
      topFunctions: [
        {
          name: 'recalculate',
          url: '/home/pi/.signalk/node_modules/signalk-derived-data/index.js',
          selfTimeMs: 4200,
        },
      ],
    },
    { name: 'node runtime', selfTimeMs: 2220, percent: 7.4 },
  ],
  // self/total in microseconds, matching the bucket self times above.
  flame: {
    name: '(root)',
    bucket: '(root)',
    self: 0,
    total: 30_000_000,
    children: [
      { name: '(idle)', bucket: '(idle)', self: 18_360_000, total: 18_360_000 },
      {
        name: 'processDeltas',
        bucket: 'signalk-server (core)',
        self: 2_120_000,
        total: 5_220_000,
        url: 'file:///usr/lib/node_modules/signalk-server/lib/deltas.js',
        children: [
          {
            name: 'buildFullFromDeltas',
            bucket: 'signalk-server (core)',
            self: 3_100_000,
            total: 3_100_000,
            url: 'file:///usr/lib/node_modules/signalk-server/lib/fullsignalk.js',
          },
        ],
      },
      {
        name: 'recalculate',
        bucket: 'signalk-derived-data',
        self: 4_200_000,
        total: 4_200_000,
        url: '/home/pi/.signalk/node_modules/signalk-derived-data/index.js',
      },
      {
        name: 'readFileHandle',
        bucket: 'node runtime',
        self: 2_220_000,
        total: 2_220_000,
        url: 'node:fs/promises',
      },
    ],
  },
}

export const heapReportFixture: HeapReport = {
  id: 'heap-2026-07-28T09-00-00-000Z',
  type: 'heap',
  capturedAt: '2026-07-28T09:00:00.000Z',
  durationMs: 30000,
  samplingIntervalBytes: 32768,
  totalBytes: 4_194_304,
  buckets: [
    {
      name: 'plugin-x',
      selfBytes: 3_145_728,
      percent: 75,
      topFunctions: [
        {
          name: 'allocateBuffers',
          url: '/home/pi/.signalk/node_modules/plugin-x/index.js',
          selfBytes: 3_145_728,
        },
      ],
    },
    { name: 'node runtime', selfBytes: 1_048_576, percent: 25 },
  ],
  // self/total in bytes, matching the bucket self sizes above.
  flame: {
    name: '(root)',
    bucket: '(root)',
    self: 0,
    total: 4_194_304,
    children: [
      {
        name: 'allocateBuffers',
        bucket: 'plugin-x',
        self: 3_145_728,
        total: 4_194_304,
        url: '/home/pi/.signalk/node_modules/plugin-x/index.js',
        children: [
          {
            name: 'concat',
            bucket: 'node runtime',
            self: 1_048_576,
            total: 1_048_576,
            url: 'node:buffer',
          },
        ],
      },
    ],
  },
}

export const profileListFixture: ProfileListResponse = {
  running: null,
  profiles: [
    {
      id: 'cpu-2026-07-28T10-00-00-000Z',
      type: 'cpu',
      capturedAt: '2026-07-28T10:00:00.000Z',
      durationMs: 30000,
      rawSizeBytes: 245_760,
    },
    {
      id: 'heap-2026-07-28T09-00-00-000Z',
      type: 'heap',
      capturedAt: '2026-07-28T09:00:00.000Z',
      durationMs: 30000,
      rawSizeBytes: 51_200,
    },
  ],
}
