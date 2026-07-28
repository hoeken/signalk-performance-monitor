# signalk-performance-monitor — Specification

## Overview

A Signal K server plugin + webapp that provides always-on performance metrics and on-demand CPU/allocation profiling for a running Signal K server, with per-plugin attribution. Requires **no server core modifications** — it uses the standard plugin API and Node's built-in `node:inspector` module, which allows a process to profile itself.

**Package:** `signalk-performance-monitor`
**Keywords:** `signalk-node-server-plugin`, `signalk-webapp`, `performance`, `profiler`, `cpu`, `monitoring`, `diagnostics`
**Requires:** Node ≥ 20 (uses `node:inspector/promises`), Signal K server ≥ 2.x
**Language:** TypeScript everywhere (`strict: true`) — plugin backend compiled with `tsc` to `dist/`, webapp bundled with Vite; tests and tooling config in TS as well

## Problem

Signal K server runs all JavaScript — delta processing, WebSocket fanout, REST API, and every plugin — on a single event loop, typically on Raspberry Pi hardware. When something blocks or saturates that loop, everything degrades at once, and today there is no way to see (a) that it's happening, or (b) which code is responsible. Existing server stats cover delta throughput only, not CPU time.

## Goals

1. Continuously measure event-loop health and publish it as Signal K data.
2. Capture on-demand CPU profiles of the live server with negligible idle overhead.
3. Attribute CPU and allocation cost **per plugin** without requiring any changes to those plugins or to the server.
4. Make results consumable three ways: at-a-glance webapp, raw `.cpuprofile` download, and Signal K deltas (so existing logging/graphing plugins work unmodified).

## Non-Goals

- Profiling child processes (e.g. canboat `analyzer`) or worker threads — main thread only, which is the contended resource.
- Full heap snapshots (unsafe on memory-constrained hardware).
- Always-on profiling. Capture is explicitly bounded and on-demand.
- Modifying, wrapping, or instrumenting other plugins in any way.

---

## Feature 1: Continuous metrics

On plugin start, begin collecting; every `publishIntervalSeconds` (default 5), emit one delta via `app.handleMessage`.

| Path                               | Source                                                   | Unit        |
| ---------------------------------- | -------------------------------------------------------- | ----------- |
| `performance.eventLoopDelay.p50`   | `monitorEventLoopDelay()` percentile                     | s           |
| `performance.eventLoopDelay.p99`   | 〃                                                       | s           |
| `performance.eventLoopDelay.max`   | 〃 (reset each interval)                                 | s           |
| `performance.eventLoopUtilization` | `performance.eventLoopUtilization()` diffed per interval | ratio (0–1) |
| `performance.gc.pauseTime`         | `PerformanceObserver` on `'gc'`, summed per interval     | s           |
| `performance.memory.heapUsed`      | `process.memoryUsage()`                                  | bytes       |
| `performance.memory.rss`           | 〃                                                       | bytes       |
| `performance.cpu.utilization`      | `process.cpuUsage()` diffed per interval                 | ratio       |

Notes:

- All units SI per Signal K convention; emit `meta` with units on first publish.
- Path prefix configurable (default `performance`); publishing can be disabled entirely, leaving webapp-only access via a `GET /metrics` route.
- Publishing as deltas is the integration hook: data browser, `signalk-to-influxdb`/Grafana, and alerting plugins all work with zero additional code.
- Implementation must respect the server's hot-path rules: no per-interval allocation churn, single object literal per delta.

## Feature 2: On-demand CPU profiling

- `POST /profile` with `{ duration: seconds, samplingIntervalUs?: number }` starts a capture using a self-connected `inspector.Session` (`Profiler.enable` → `setSamplingInterval` → `start` → wait → `stop`).
- Defaults: 30s duration, 1000µs sampling. Hard caps: `maxProfileDurationSeconds` (default 120), one capture at a time (409 on overlap).
- The V8 sampling profiler runs off-thread; overhead is a few percent **only while capturing**, zero otherwise.
- Raw result is standard `.cpuprofile` JSON, stored on disk in the plugin's data dir; keep the most recent `maxStoredProfiles` (default 5), delete older.

## Feature 3: Per-plugin attribution

Post-process each profile into an aggregated report. Self-time per call-tree node = sum of `timeDeltas` at that node's sample indices. Bucket each node by `callFrame.url`:

1. `/node_modules/@scope/<pkg>/` or `/node_modules/<pkg>/` → that package (matches both server-local and `~/.signalk/node_modules` installs; take the **last** `node_modules` segment in the path to handle nested deps).
2. Signal K server's own `lib/`/`src/` files → `signalk-server (core)`.
3. `node:*` internals → `node runtime`.
4. V8 synthetic frames pass through as their own rows: `(idle)`, `(garbage collector)`, `(program)`.

Report format (stored alongside the raw profile):

```json
{
  "capturedAt": "...",
  "durationMs": 30000,
  "samplingIntervalUs": 1000,
  "buckets": [
    { "name": "(idle)", "selfTimeMs": 18360, "percent": 61.2 },
    {
      "name": "signalk-server (core)",
      "selfTimeMs": 5220,
      "percent": 17.4,
      "topFunctions": [{ "name": "buildFullFromDeltas", "url": "...", "selfTimeMs": 3100 }]
    }
  ]
}
```

Include `topFunctions` (top 10 by self-time) per bucket so plugin authors can act on reports.

## Feature 4: Allocation profiling (v0.4)

Same flow as Feature 2 using `HeapProfiler.startSampling` / `stopSampling`; reuse the identical URL-bucketing for "which plugin allocates most." Explicitly do **not** expose `takeHeapSnapshot`.

---

## HTTP API

All routes registered via `registerWithRouter` directly on the router — **admin-only by default** under the server's security strategy. Base: `/plugins/signalk-performance-monitor/`.

| Method | Route                 | Description                                                |
| ------ | --------------------- | ---------------------------------------------------------- |
| GET    | `/metrics`            | Current metrics snapshot (JSON)                            |
| POST   | `/profile`            | Start CPU capture; returns `{ id }`; 409 if one is running |
| GET    | `/profile`            | List stored profiles + status of any running capture       |
| GET    | `/profile/:id/report` | Aggregated per-plugin report                               |
| GET    | `/profile/:id/raw`    | Raw `.cpuprofile` (opens in Chrome DevTools / speedscope)  |
| DELETE | `/profile/:id`        | Delete a stored profile                                    |
| POST   | `/heap-profile`       | (v0.4) allocation capture, same shape                      |

## Configuration schema

```json
{
  "publishIntervalSeconds": { "type": "number", "default": 5 },
  "publishDeltas": { "type": "boolean", "default": true },
  "pathPrefix": { "type": "string", "default": "performance" },
  "defaultProfileDurationSeconds": { "type": "number", "default": 30 },
  "maxProfileDurationSeconds": { "type": "number", "default": 120 },
  "samplingIntervalUs": { "type": "number", "default": 1000 },
  "maxStoredProfiles": { "type": "number", "default": 5 }
}
```

## Webapp

Modern React single-page app, built with Vite into static assets under `public/` (auto-mounted at `/signalk-performance-monitor` via the `signalk-webapp` keyword):

- **Stack:** React 18+, TypeScript, Vite. Runtime dependencies stay lean — React plus at most one lightweight charting library; no heavyweight UI frameworks.
- Live metrics tiles (loop delay p99, ELU, heap, GC) polled from `/metrics` or the SK stream.
- "Profile for 30s" button → progress → per-plugin table (bucket, %, bar) → expandable top-functions per bucket → download raw link.
- Components developed test-first with Vitest + React Testing Library against fixture API responses (see Development Practices).
- Flamegraph rendering deferred (raw file opens in DevTools/speedscope).

## Plugin lifecycle

- `start(options)`: begin metrics collection, register observer/histogram; nothing else.
- `stop()`: disable histogram/observers, clear the publish interval, abort any in-flight capture and disconnect the inspector session.
- `setPluginStatus`: idle → "Monitoring (loop p99: Xms)"; capturing → "Profiling: Ns remaining".

## Security considerations

- Profiles reveal file paths and function names — admin-only routes (the default) are required, not optional.
- The inspector session is in-process and self-connected; it does **not** open a debug port. No new attack surface beyond what an admin-installed plugin already has.
- Cap capture duration and stored profile count to bound CPU and disk on small devices.

## Known limitations

- Main thread only; native addon internals appear as `(program)`/unresolved.
- Sampling at 1ms misses rare sub-millisecond functions; statistically sound for anything that matters at sustained load.
- One capture at a time; a plugin restart aborts an in-flight capture.
- Report buckets depend on file paths; a plugin that bundles dependencies absorbs their cost into its own bucket (arguably correct).

## Development Practices

**Test-driven development.** Tests are written before or alongside the code they cover; a feature is not done until its tests pass. All test layers run via Vitest:

- **Unit tests** — the URL → bucket attribution logic against captured fixture `.cpuprofile` files (scoped packages, nested `node_modules`, file URLs vs paths, synthetic frames); metrics delta shaping; profile store rotation/cleanup.
- **Integration tests** — HTTP routes exercised against a mocked Signal K plugin/server interface (capture start, 409 on overlap, duration caps, list/report/delete).
- **Component tests** — React Testing Library for webapp tiles, profile flow, and the per-plugin report table, rendered from fixture API responses.
- CI runs the full suite (plus type-check, lint, and format checks) on every push.

**TypeScript.** Everything is TypeScript with `strict: true` — plugin backend, webapp, and tests. The backend compiles via `tsc` to `dist/` (the package `main`); the webapp type-checks via `tsc --noEmit` and bundles via Vite. Shared types for the report/metrics JSON shapes live in one place and are imported by both backend and webapp, so the API contract is checked at compile time.

**Linting & formatting.** ESLint (typescript-eslint + React plugins) and Prettier, enforced automatically rather than by convention:

- `husky` + `lint-staged` pre-commit hook runs `eslint` and `prettier --check` on staged files — check-only, no auto-fixing: a violation fails the commit and the developer fixes it explicitly (e.g. via `npm run lint:fix` / `npm run format`).
- Standard scripts: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`; CI fails on type errors, lint errors, or format drift.

## Milestones

1. **v0.1** — metrics collection + delta publishing + `/metrics` route.
2. **v0.2** — CPU capture + raw `.cpuprofile` storage/download.
3. **v0.3** — per-plugin aggregation report + React webapp. ← _announceable_
4. **v0.4** — allocation profiling.
5. **Later** — in-browser flamegraph; loop-delay alerting via SK notifications; optionally graduate always-on gauges into server core (`deltastats.ts`) as a separate PR with this plugin as evidence.

---

## Implementation note

The per-plugin attribution logic (URL → bucket) is the piece with real edge cases (scoped packages, nested `node_modules`, file URLs vs paths, source-mapped bundles) — it is the poster child for the TDD approach above: write the fixture-driven unit tests first, from day one. The rest is mostly plumbing.
