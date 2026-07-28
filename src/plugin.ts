/**
 * Plugin wiring: lifecycle, config, delta publishing, and status reporting.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter } from 'express'
import { CaptureManager } from './capture'
import { buildMetaDelta, buildMetricsDelta } from './deltas'
import { HttpRequestTracker } from './http-requests'
import { MetricsCollector } from './metrics'
import { registerRoutes, type RouteDeps } from './routes'
import { ProfileStore } from './store'
import type { RunningCapture } from './shared/types'

export const PLUGIN_ID = 'signalk-performance-monitor'

export interface PerformanceMonitorConfig {
  publishIntervalSeconds: number
  publishDeltas: boolean
  defaultProfileDurationSeconds: number
  maxProfileDurationSeconds: number
  samplingIntervalUs: number
  maxStoredProfiles: number
}

export const CONFIG_DEFAULTS: PerformanceMonitorConfig = {
  publishIntervalSeconds: 5,
  publishDeltas: true,
  defaultProfileDurationSeconds: 30,
  maxProfileDurationSeconds: 120,
  samplingIntervalUs: 1000,
  maxStoredProfiles: 5,
}

const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    publishIntervalSeconds: {
      type: 'number',
      title: 'Publish interval (seconds)',
      description: 'How often metrics are sampled and published',
      default: CONFIG_DEFAULTS.publishIntervalSeconds,
      minimum: 1,
    },
    publishDeltas: {
      type: 'boolean',
      title: 'Publish Signal K deltas',
      description:
        'Emit metrics as Signal K deltas (for the data browser, InfluxDB/Grafana, alerting). When off, metrics remain available via the webapp and GET /metrics.',
      default: CONFIG_DEFAULTS.publishDeltas,
    },
    defaultProfileDurationSeconds: {
      type: 'number',
      title: 'Default profile duration (seconds)',
      default: CONFIG_DEFAULTS.defaultProfileDurationSeconds,
      minimum: 1,
    },
    maxProfileDurationSeconds: {
      type: 'number',
      title: 'Maximum profile duration (seconds)',
      description: 'Hard cap for a single capture',
      default: CONFIG_DEFAULTS.maxProfileDurationSeconds,
      minimum: 1,
    },
    samplingIntervalUs: {
      type: 'number',
      title: 'CPU sampling interval (microseconds)',
      default: CONFIG_DEFAULTS.samplingIntervalUs,
      minimum: 100,
    },
    maxStoredProfiles: {
      type: 'number',
      title: 'Stored profiles per type',
      description: 'Older captures are deleted beyond this count',
      default: CONFIG_DEFAULTS.maxStoredProfiles,
      minimum: 1,
    },
  },
}

/**
 * Locate the Signal K server package root (for source checkouts that do not
 * live under node_modules), by walking up from the entry module.
 */
export function detectServerRoot(startFile?: string): string | undefined {
  try {
    const entry = startFile ?? (typeof require !== 'undefined' ? require.main?.filename : undefined)
    if (!entry) return undefined
    let dir = path.dirname(entry)
    for (let depth = 0; depth < 10; depth++) {
      const packageJson = path.join(dir, 'package.json')
      if (existsSync(packageJson)) {
        try {
          const pkg = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string }
          if (pkg.name === 'signalk-server') return dir
        } catch {
          // unreadable package.json; keep walking up
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // detection is best-effort only
  }
  return undefined
}

export function createPlugin(app: ServerAPI): Plugin {
  let config = CONFIG_DEFAULTS
  let collector: MetricsCollector | null = null
  let httpRequests: HttpRequestTracker | null = null
  let captures: CaptureManager | null = null
  let deps: RouteDeps | null = null
  let publishTimer: NodeJS.Timeout | null = null
  let captureStatusTimer: NodeJS.Timeout | null = null

  const setMonitoringStatus = () => {
    const p99 = collector?.latest()?.eventLoopDelay.p99
    app.setPluginStatus(
      p99 === undefined ? 'Monitoring' : `Monitoring (loop p99: ${(p99 * 1000).toFixed(1)}ms)`,
    )
  }

  const onCaptureStatus = (running: RunningCapture | null) => {
    if (captureStatusTimer) {
      clearInterval(captureStatusTimer)
      captureStatusTimer = null
    }
    if (!running) {
      setMonitoringStatus()
      return
    }
    const tick = () => {
      const status = captures?.status()
      if (status) {
        const kind =
          status.type === 'heap'
            ? 'Heap profiling'
            : status.type === 'files'
              ? 'File profiling'
              : 'Profiling'
        app.setPluginStatus(`${kind}: ${status.remainingSeconds}s remaining`)
      }
    }
    tick()
    captureStatusTimer = setInterval(tick, 1000)
  }

  const publish = () => {
    try {
      if (!collector) return
      const snapshot = collector.sample()
      if (config.publishDeltas) {
        app.handleMessage(PLUGIN_ID, buildMetricsDelta(snapshot))
      }
      if (!captures?.status()) {
        setMonitoringStatus()
      }
    } catch (error) {
      app.error(`metrics publish failed: ${String(error)}`)
    }
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Performance Monitor',
    description:
      'Event-loop health metrics and on-demand CPU/allocation profiling with per-plugin attribution',
    schema: () => CONFIG_SCHEMA,

    start(options: object) {
      config = { ...CONFIG_DEFAULTS, ...(options as Partial<PerformanceMonitorConfig>) }

      collector = new MetricsCollector()
      collector.start()
      collector.sample() // establish a baseline so GET /metrics answers immediately

      httpRequests = new HttpRequestTracker()
      httpRequests.start()

      const dataDir = app.getDataDirPath()
      const store = new ProfileStore(dataDir, config.maxStoredProfiles)
      const serverRoot = detectServerRoot()
      // The data dir is <configDir>/plugin-config-data/<plugin-id>; two
      // levels up is the Signal K config root that file paths are
      // attributed against.
      const dataRoot = path.dirname(path.dirname(dataDir))
      captures = new CaptureManager({
        store,
        bucketOptions: { serverRoot },
        dataPathOptions: { dataRoot, serverRoot },
        onStatus: onCaptureStatus,
        onError: (error) => app.error(`capture failed: ${String(error)}`),
      })

      deps = {
        metrics: collector,
        httpRequests,
        captures,
        store,
        options: {
          defaultProfileDurationSeconds: config.defaultProfileDurationSeconds,
          maxProfileDurationSeconds: config.maxProfileDurationSeconds,
          samplingIntervalUs: config.samplingIntervalUs,
        },
      }

      if (config.publishDeltas) {
        app.handleMessage(PLUGIN_ID, buildMetaDelta())
      }
      const intervalMs = Math.max(config.publishIntervalSeconds, 1) * 1000
      publishTimer = setInterval(publish, intervalMs)
      setMonitoringStatus()
      app.debug('started')
    },

    stop() {
      if (publishTimer) {
        clearInterval(publishTimer)
        publishTimer = null
      }
      if (captureStatusTimer) {
        clearInterval(captureStatusTimer)
        captureStatusTimer = null
      }
      const abortable = captures
      captures = null
      deps = null
      abortable?.abort().catch((error) => app.error(`capture abort failed: ${String(error)}`))
      collector?.stop()
      collector = null
      httpRequests?.stop()
      httpRequests = null
      app.setPluginStatus('Stopped')
      app.debug('stopped')
    },

    registerWithRouter(router: IRouter) {
      registerRoutes(router, () => deps, {
        error: (message) => app.error(message),
      })
    },
  }

  return plugin
}
