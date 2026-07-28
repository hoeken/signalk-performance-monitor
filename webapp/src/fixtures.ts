/** Fixture API responses for component tests. */
import type {
  CpuReport,
  FilesReport,
  HeapReport,
  HttpRequestsResponse,
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
  http: { requestRate: 3.4, requestDuration: { p50: 0.0042, p99: 0.0871, max: 0.1502 } },
  resources: {
    diskReadRate: 12_288,
    diskWriteRate: 46_285,
    involuntaryContextSwitchRate: 123.4,
    majorPageFaultRate: 0,
  },
}

export const httpRequestsFixture: HttpRequestsResponse = {
  recent: [
    {
      timestamp: '2026-07-28T10:15:29.500Z',
      method: 'GET',
      path: '/signalk/v1/api/vessels/self?depth=1',
      statusCode: 200,
      durationMs: 4.2,
      responseBytes: 1832,
    },
    {
      timestamp: '2026-07-28T10:15:28.000Z',
      method: 'PUT',
      path: '/signalk/v1/api/vessels/self/steering/autopilot',
      statusCode: 405,
      durationMs: 1.1,
    },
    {
      timestamp: '2026-07-28T10:15:27.000Z',
      method: 'GET',
      path: '/plugins/signalk-performance-monitor/metrics',
      statusCode: 200,
      durationMs: 0.9,
      responseBytes: 512,
    },
  ],
  aggregate: [
    {
      method: 'GET',
      path: '/signalk/v1/api/vessels/self',
      count: 240,
      totalMs: 1008,
      maxMs: 22.5,
      errorCount: 0,
      totalBytes: 439_680,
      lastSeen: '2026-07-28T10:15:29.500Z',
    },
    {
      method: 'PUT',
      path: '/signalk/v1/api/vessels/self/steering/autopilot',
      count: 3,
      totalMs: 3.3,
      maxMs: 1.2,
      errorCount: 3,
      totalBytes: 0,
      lastSeen: '2026-07-28T10:15:28.000Z',
    },
    {
      method: 'GET',
      path: '/plugins/signalk-performance-monitor/metrics',
      count: 500,
      totalMs: 450,
      maxMs: 9.1,
      errorCount: 0,
      totalBytes: 256_000,
      lastSeen: '2026-07-28T10:15:27.000Z',
    },
  ],
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
          url: '/data/.signalk/node_modules/signalk-derived-data/index.js',
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
        url: '/data/.signalk/node_modules/signalk-derived-data/index.js',
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
          url: '/data/.signalk/node_modules/plugin-x/index.js',
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
        url: '/data/.signalk/node_modules/plugin-x/index.js',
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

export const filesReportFixture: FilesReport = {
  id: 'files-2026-07-28T08-00-00-000Z',
  type: 'files',
  capturedAt: '2026-07-28T08:00:00.000Z',
  durationMs: 30000,
  sampleIntervalSeconds: 1,
  sampleCount: 31,
  dataRoot: '/data/.signalk',
  totals: {
    writeBytes: 1_572_864,
    readBytes: 0,
    writeBytesPerSecond: 52_428.8,
    readBytesPerSecond: 0,
  },
  files: [
    {
      path: '/data/.signalk/plugin-config-data/maintenance-tracker/maintenance.db-wal',
      bucket: 'maintenance-tracker',
      mode: 'read-write',
      kind: 'sqlite-wal',
      sizeBytes: 4_152_000,
      growthBytes: 0,
      mtimeChanges: 30,
      inPlaceRewrites: 30,
    },
    {
      path: '/data/.signalk/plugin-config-data/maintenance-tracker/maintenance.db',
      bucket: 'maintenance-tracker',
      mode: 'read-write',
      kind: 'sqlite-db',
      sizeBytes: 262_144,
      growthBytes: 0,
      mtimeChanges: 0,
      inPlaceRewrites: 0,
    },
    {
      path: '/data/.signalk/serverstate/course/courseInfo.json',
      bucket: 'signalk-server (core)',
      mode: 'write',
      kind: 'file',
      sizeBytes: 812,
      growthBytes: 24_360,
      mtimeChanges: 30,
      inPlaceRewrites: 0,
    },
    {
      path: '/data/.signalk/settings.json',
      bucket: 'signalk-server (core)',
      mode: 'read',
      kind: 'file',
      sizeBytes: 9_216,
      growthBytes: 0,
      mtimeChanges: 0,
      inPlaceRewrites: 0,
    },
  ],
  databases: [
    {
      path: '/data/.signalk/plugin-config-data/maintenance-tracker/maintenance.db',
      bucket: 'maintenance-tracker',
      pageSize: 4096,
      commits: 240,
      commitsPerSecond: 8,
      framesWritten: 240,
      checkpoints: 1,
      estimatedWriteBytes: 1_064_640,
      notes: ['8/s sustained commits — each one costs an fsync; consider batching writes'],
    },
  ],
  attribution: [
    { name: 'maintenance-tracker', estimatedWriteBytes: 1_064_640, percent: 67.7 },
    { name: 'signalk-server (core)', estimatedWriteBytes: 24_360, percent: 1.5 },
    { name: '(unattributed)', estimatedWriteBytes: 483_864, percent: 30.8 },
  ],
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
    {
      id: 'files-2026-07-28T08-00-00-000Z',
      type: 'files',
      capturedAt: '2026-07-28T08:00:00.000Z',
      durationMs: 30000,
      rawSizeBytes: 18_432,
    },
  ],
}
