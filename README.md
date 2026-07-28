# signalk-performance-monitor

Always-on event-loop health metrics and on-demand CPU/allocation profiling for a running
[Signal K](https://signalk.org) server — with **per-plugin attribution**, so you can see
_which_ plugin (or the server core) is eating your Raspberry Pi.

Signal K runs all JavaScript — delta processing, WebSocket fanout, REST API, and every
plugin — on a single event loop. When something blocks or saturates that loop, everything
degrades at once. This plugin makes that visible, and tells you who is responsible, using
only the standard plugin API and Node's built-in `node:inspector` module. **No server core
modifications, no changes to other plugins.**

## Features

- **Continuous metrics** published as Signal K deltas every 5 s (configurable):
  event-loop delay p50/p99/max, event-loop utilization, GC pause time, heap/RSS,
  process CPU utilization, HTTP request rate and duration percentiles, disk I/O
  operation rates, involuntary context switches, and major page faults. Works out
  of the box with the data browser, `signalk-to-influxdb`/Grafana, and alerting
  plugins.
- **On-demand CPU profiling** of the live server via a self-connected inspector session.
  The V8 sampling profiler runs off-thread: a few percent overhead _only while capturing_,
  zero otherwise. No debug port is opened.
- **Per-plugin reports**: each profile is post-processed into buckets —
  `<plugin package>`, `signalk-server (core)`, `node runtime`, `(idle)`,
  `(garbage collector)` — with the top functions per bucket by self-time.
- **Allocation profiling** (sampling heap profiler) with the same per-plugin bucketing:
  see which plugin allocates most. Full heap snapshots are deliberately not exposed
  (unsafe on memory-constrained hardware).
- **Webapp**: live metric tiles, one-click "Profile for 30s", an in-browser **flame
  graph** (click to zoom, colored by plugin) for both CPU and allocation reports,
  per-plugin table with share bars and expandable top functions, raw profile JSON
  download (opens in Chrome DevTools or [speedscope](https://www.speedscope.app/)).

## Install

Search for **signalk-performance-monitor** in the Signal K Appstore, or:

```sh
cd ~/.signalk
npm install signalk-performance-monitor
```

then restart the server and enable the plugin in _Server → Plugin Config_. The webapp
appears under _Webapps_ as **Performance Monitor**. Requires Node ≥ 20 and Signal K
server ≥ 2.x.

## Signal K paths

| Path                                                     | Unit                |
| -------------------------------------------------------- | ------------------- |
| `performance.eventLoopDelay.p50` / `.p99` / `.max`       | s                   |
| `performance.eventLoopUtilization`                       | ratio 0–1           |
| `performance.gc.pauseTime`                               | s (per interval)    |
| `performance.memory.heapUsed` / `.rss`                   | bytes               |
| `performance.cpu.utilization`                            | ratio               |
| `performance.http.requestRate`                           | Hz (requests/s)     |
| `performance.http.requestDuration.p50` / `.p99` / `.max` | s                   |
| `performance.disk.readRate` / `.writeRate`               | Hz (512 B blocks/s) |
| `performance.cpu.involuntaryContextSwitchRate`           | Hz                  |
| `performance.memory.majorPageFaultRate`                  | Hz                  |

Disk I/O is counted in the kernel's 512-byte block units (2000 writes/s ≈ 1 MB/s), and
reads count only page-cache misses — a steady 0 is normal on a warmed-up server.

Delta publishing can be disabled entirely, leaving webapp/HTTP-only access.

## HTTP API

All routes are registered on the plugin router — **admin-only** under the server's
security strategy, which is required, not optional: profiles reveal file paths and
function names. Base: `/plugins/signalk-performance-monitor`.

| Method | Route                 | Description                                                                              |
| ------ | --------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/metrics`            | Current metrics snapshot (JSON)                                                          |
| POST   | `/profile`            | Start CPU capture `{ duration?, samplingIntervalUs? }` → `{ id }`; 409 if one is running |
| POST   | `/heap-profile`       | Start allocation capture `{ duration?, samplingIntervalBytes? }` → `{ id }`              |
| GET    | `/profile`            | Stored profiles + status of any running capture                                          |
| GET    | `/profile/:id/report` | Aggregated per-plugin report                                                             |
| GET    | `/profile/:id/raw`    | Raw profile download (`.json`)                                                           |
| DELETE | `/profile/:id`        | Delete a stored profile                                                                  |

Example report:

```json
{
  "capturedAt": "2026-07-28T10:00:00.000Z",
  "durationMs": 30000,
  "samplingIntervalUs": 1000,
  "buckets": [
    { "name": "(idle)", "selfTimeMs": 18360, "percent": 61.2 },
    {
      "name": "signalk-server (core)",
      "selfTimeMs": 5220,
      "percent": 17.4,
      "topFunctions": [
        { "name": "buildFullFromDeltas", "url": "…/lib/fullsignalk.js", "selfTimeMs": 3100 }
      ]
    }
  ],
  "flame": {
    "name": "(root)",
    "bucket": "(root)",
    "self": 0,
    "total": 29988400,
    "children": ["… the aggregated call tree (µs for CPU, bytes for heap) …"]
  }
}
```

`flame` is the call tree the webapp renders as a flame graph; subtrees below 0.1% of
the total are pruned (their cost stays in the ancestors' totals).

## Configuration

| Option                          | Default | Description                                      |
| ------------------------------- | ------- | ------------------------------------------------ |
| `publishIntervalSeconds`        | 5       | Metrics sampling/publishing interval             |
| `publishDeltas`                 | true    | Emit Signal K deltas (off → webapp/HTTP only)    |
| `defaultProfileDurationSeconds` | 30      | Capture duration when none is given              |
| `maxProfileDurationSeconds`     | 120     | Hard cap for a single capture                    |
| `samplingIntervalUs`            | 1000    | CPU profiler sampling interval                   |
| `maxStoredProfiles`             | 5       | Stored captures per type; older ones are deleted |

## How attribution works

Self-time per call-tree node is summed from the profile's `timeDeltas`, then each node is
bucketed by its `callFrame.url`:

1. `…/node_modules/<pkg>/` or `…/node_modules/@scope/<pkg>/` → that package (the _last_
   `node_modules` segment wins, so nested dependencies attribute to the leaf package).
2. The Signal K server's own files → `signalk-server (core)`.
3. `node:*` internals → `node runtime`.
4. V8 synthetic frames pass through: `(idle)`, `(garbage collector)`, `(program)`.

Known limits: main thread only (child processes like canboat `analyzer` are not profiled);
1 ms sampling misses rare sub-millisecond functions; a plugin that bundles its dependencies
absorbs their cost into its own bucket; one capture at a time.

## Development

TypeScript everywhere (`strict: true`), test-driven — unit tests for attribution against
fixture `.cpuprofile` files, integration tests that profile the test process itself through
the real HTTP routes, and React Testing Library component tests from fixture API responses.

```sh
npm install
npm test              # backend + webapp suites (vitest)
npm run typecheck     # tsc over backend, tests, webapp
npm run lint          # eslint
npm run format:check  # prettier
npm run build         # tsc → dist/, vite → public/
```

A husky pre-commit hook runs eslint + `prettier --check` on staged files (check-only);
CI runs the full suite on every push.

## License

MIT © Zach Hoeken
