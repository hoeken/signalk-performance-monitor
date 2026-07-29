# signalk-performance-monitor — Specification

> **Status:** implemented. This document describes the plugin as built (v0.5.0 — all
> planned milestones shipped, including allocation profiling and the in-browser flame
> graph). Remaining ideas live under [Future work](#future-work).

## Overview

A Signal K server plugin + webapp that provides always-on performance metrics and on-demand CPU/allocation profiling for a running Signal K server, with per-plugin attribution. Requires **no server core modifications** — it uses the standard plugin API and Node's built-in `node:inspector` module, which allows a process to profile itself.

**Package:** `signalk-performance-monitor`
**Keywords:** `signalk-node-server-plugin`, `signalk-webapp`, `signalk-category-utility`, `performance`, `profiler`, `cpu`, `monitoring`, `diagnostics`
**Requires:** Node ≥ 20 (uses `node:inspector/promises`), Signal K server ≥ 2.x
**Language:** TypeScript everywhere (`strict: true`) — plugin backend compiled with `tsc` to `dist/`, webapp bundled with Vite into `public/`; tests and tooling config in TS as well

## Problem

Signal K server runs all JavaScript — delta processing, WebSocket fanout, REST API, and every plugin — on a single event loop, typically on Raspberry Pi hardware. When something blocks or saturates that loop, everything degrades at once, and today there is no way to see (a) that it's happening, or (b) which code is responsible. Existing server stats cover delta throughput only, not CPU time.

## Goals

1. Continuously measure event-loop health and publish it as Signal K data.
2. Capture on-demand CPU profiles of the live server with negligible idle overhead.
3. Attribute CPU and allocation cost **per plugin** without requiring any changes to those plugins or to the server.
4. Make results consumable three ways: at-a-glance webapp, raw `.cpuprofile`/`.heapprofile` download, and Signal K deltas (so existing logging/graphing plugins work unmodified).

## Non-Goals

- Profiling child processes (e.g. canboat `analyzer`) or worker threads — main thread only, which is the contended resource.
- Full heap snapshots (unsafe on memory-constrained hardware). Allocation profiling uses the sampling heap profiler only; `takeHeapSnapshot` is never exposed.
- Always-on profiling. Capture is explicitly bounded and on-demand.
- Modifying, wrapping, or instrumenting other plugins in any way.

---

## Feature 1: Continuous metrics

On plugin start, `MetricsCollector` (`src/metrics.ts`) begins collecting and takes a baseline sample so `GET /metrics` answers immediately. Every `publishIntervalSeconds` (default 5) it samples and — when `publishDeltas` is on — emits one delta via `app.handleMessage`. All sources are diffed or reset per interval; values are rounded to 6 decimals.

| Path                                           | Source                                                             | Unit        |
| ---------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| `performance.eventLoopDelay.p50`               | `monitorEventLoopDelay()` percentile (histogram reset each sample) | s           |
| `performance.eventLoopDelay.p99`               | 〃                                                                 | s           |
| `performance.eventLoopDelay.max`               | 〃                                                                 | s           |
| `performance.eventLoopUtilization`             | `performance.eventLoopUtilization()` diffed per interval           | ratio (0–1) |
| `performance.gc.pauseTime`                     | `PerformanceObserver` on `'gc'`, summed per interval               | s           |
| `performance.memory.heapUsed`                  | `process.memoryUsage()`                                            | bytes       |
| `performance.memory.rss`                       | 〃                                                                 | bytes       |
| `performance.cpu.utilization`                  | `process.cpuUsage()` (user + system) diffed against wall time      | ratio       |
| `performance.http.requestRate`                 | `PerformanceObserver` on `'http'`, count per interval              | Hz          |
| `performance.http.requestDuration.p50`         | 〃 durations into a `createHistogram()`, reset each sample         | s           |
| `performance.http.requestDuration.p99`         | 〃                                                                 | s           |
| `performance.http.requestDuration.max`         | 〃                                                                 | s           |
| `performance.disk.readRate`                    | `/proc/self/io read_bytes` diffed per interval                     | B/s         |
| `performance.disk.writeRate`                   | `/proc/self/io write_bytes` diffed per interval                    | B/s         |
| `performance.cpu.involuntaryContextSwitchRate` | `process.resourceUsage().involuntaryContextSwitches` diffed        | Hz          |
| `performance.memory.majorPageFaultRate`        | `process.resourceUsage().majorPageFault` diffed                    | Hz          |

Notes:

- All units SI per Signal K convention; a `meta` delta with units and descriptions is emitted once at plugin start (`buildMetaDelta` in `src/deltas.ts`).
- HTTP timing counts only inbound `HttpRequest` entries (outbound `HttpClient` entries are filtered out) and covers every request handled anywhere in the process — REST, admin UI, webapps — but not WebSocket traffic. Node emits `'http'` performance entries only while an observer is subscribed, so the per-request cost exists only while the plugin runs. Durations report as all zeros in a request-free interval.
- `process.resourceUsage()` counters are monotonic; each is diffed per interval and divided by wall time into a rate (clamped at 0, like CPU).
- Disk rates are byte-accurate from `/proc/self/io` (`read_bytes`/`write_bytes` — the kernel's count of bytes the process caused to hit the storage layer, charged per clean→dirty page transition, so RAM-coalesced rewrites are nearly free while per-commit fsyncs recharge in full). Where procfs is unavailable (non-Linux), they fall back to `resourceUsage().fsRead`/`fsWrite` 512-byte block counts × 512. Reads count only page-cache misses; a warmed-up server reads everything from cache, so a steady 0 is the normal, healthy state.
- All metrics publish under the fixed `performance.` path prefix; publishing can be disabled entirely, leaving webapp-only access via the `GET /metrics` route.
- Publishing as deltas is the integration hook: data browser, `signalk-to-influxdb`/Grafana, and alerting plugins all work with zero additional code.
- Respects the server's hot-path rules: metric paths are precomputed once at module load; each publish builds a single object literal (`buildMetricsDelta`).
- The same snapshot (shape: `MetricsSnapshot` in `src/shared/types.ts`, with an ISO `timestamp`) is served by `GET /metrics` and consumed by the webapp.

### Per-request tracking

`HttpRequestTracker` (`src/http-requests.ts`) subscribes a second observer to the same `'http'` entries and keeps, in memory only (reset on plugin restart):

- a ring buffer of the newest requests (`httpLatestRequestsLimit`, default 200, 0 = unlimited) — ISO end timestamp, method, path _with_ query string, status code, duration (ms), request headers (credential-bearing values redacted), and response `Content-Length` when the response declared one (streamed/chunked responses don't);
- cumulative per-`method + path` aggregates with query strings stripped and known unbounded URL families (resource entry ids, chart tile coordinates) collapsed to their root — request count, total/max duration (average is derived client-side), error count (status ≥ 400), summed response bytes, and last-seen timestamp. The map is capped at `httpAggregateRequestsLimit` distinct keys (default 1000, 0 = unlimited); once full, the least-recently-seen row is evicted to make room, so unbounded URL spaces (ids in paths, scanners) can't grow memory.

Both are served by `GET /http-requests` (shape: `HttpRequestsResponse` in `src/shared/types.ts`, recent entries newest-first). Recording can be turned off entirely (`httpRequestsEnabled`, default true): the tracker is then never created — the observer never subscribes, so per-request cost is zero — and the route answers `{ recent: [], aggregate: [], enabled: false }`, which the webapp explains with a disabled note instead of empty tables.

## Feature 2: On-demand CPU profiling

- `POST /profile` with `{ duration?: seconds, samplingIntervalUs?: number }` starts a capture using a self-connected `inspector.Session` (`Profiler.enable` → `setSamplingInterval` → `start` → wait → `stop`). Managed by `CaptureManager` (`src/capture.ts`).
- Defaults from config: 30s duration, 1000µs sampling; both overridable per request. A duration above `maxProfileDurationSeconds` (default 120) is rejected with 400 (not clamped); non-positive or non-numeric inputs are also 400. One capture at a time — CPU or heap — with 409 on overlap.
- The V8 sampling profiler runs off-thread; overhead is a few percent **only while capturing**, zero otherwise. The session is in-process and opens no debug port.
- Raw result is standard `.cpuprofile` JSON, stored in the plugin's data dir alongside an aggregated `<id>.report.json` (Feature 3). Profile ids are `cpu-<ISO timestamp>` / `heap-<ISO timestamp>` (colons/dots dashed) and validated on every route. The most recent `maxStoredProfiles` (default 5) **per profile type** are kept; older ones are deleted (`ProfileStore` in `src/store.ts`).
- Aborting (plugin stop) tears down the inspector session and discards the partial capture without saving.

## Feature 3: Per-plugin attribution

Each profile is post-processed (`src/attribution.ts`) into an aggregated report stored alongside the raw file. Self-time per call-tree node = sum of `timeDeltas` at that node's sample indices (negative deltas from clock adjustments are skipped). Each node is bucketed by `callFrame.url`:

1. `/node_modules/@scope/<pkg>/` or `/node_modules/<pkg>/` → that package (matches both server-local and `~/.signalk/node_modules` installs; the **last** `node_modules` segment in the path wins, to handle nested deps). A `node_modules/signalk-server` match maps to `signalk-server (core)`.
2. Signal K server source checkouts (no `node_modules` in the path) → `signalk-server (core)`, via best-effort server-root detection: walk up from `require.main` looking for a `package.json` named `signalk-server` (`detectServerRoot` in `src/plugin.ts`).
3. `node:*` / `internal/` internals → `node runtime`.
4. V8 synthetic frames (URL-less, parenthesized names) pass through as their own rows: `(idle)`, `(garbage collector)`, `(program)`.
5. Anything else → `(other)`.

`file://` URLs are decoded and Windows backslashes normalized before matching.

Report format (`CpuReport` in `src/shared/types.ts`; buckets sorted by self-time descending):

```json
{
  "id": "cpu-2026-07-28T10-15-30-000Z",
  "type": "cpu",
  "capturedAt": "2026-07-28T10:15:30.000Z",
  "durationMs": 30000,
  "samplingIntervalUs": 1000,
  "totalTimeMs": 29988.4,
  "buckets": [
    { "name": "(idle)", "selfTimeMs": 18360, "percent": 61.2 },
    {
      "name": "signalk-server (core)",
      "selfTimeMs": 5220,
      "percent": 17.4,
      "topFunctions": [{ "name": "buildFullFromDeltas", "url": "...", "selfTimeMs": 3100 }]
    }
  ],
  "flame": {
    "name": "(root)",
    "bucket": "(root)",
    "self": 0,
    "total": 29988400,
    "children": ["..."]
  }
}
```

Each bucket includes `topFunctions` (top 10 by self-time) so plugin authors can act on reports — except pure synthetic buckets like `(idle)`, where a function list would add nothing and is omitted.

Each report also carries a `flame` field (`FlameNode` in `src/shared/types.ts`): the aggregated call tree the webapp renders as a flame graph. Every node has `name`, `bucket` (same attribution as the report buckets), `self`, `total`, optional `url` and `children` — integer microseconds for CPU, bytes for heap, so child widths always sum to at most the parent. Subtrees below 0.1% of the root total are pruned; their cost stays in every ancestor's `total`, it just isn't broken down further. Siblings are sorted by `total` descending. `flame` is absent when nothing was sampled (and in reports written by pre-flame-graph versions, which the webapp explains with a note).

## Feature 4: Allocation profiling

Same flow as Feature 2 via `POST /heap-profile` with `{ duration?: seconds, samplingIntervalBytes?: number }`, using `HeapProfiler.startSampling` / `stopSampling` (default sampling interval 32768 bytes). The sampling heap profile tree is walked and every node's `selfSize` runs through the identical URL-bucketing, producing a `HeapReport` (`type: "heap"`, `selfBytes`/`totalBytes` instead of milliseconds). Raw output is stored as `.heapprofile`. Explicitly does **not** expose `takeHeapSnapshot`.

## Feature 5: File activity profiling

`POST /files-profile` with `{ duration?: seconds, sampleIntervalSeconds?: number }` (default 100 ms sampling — captures are on-demand and bounded, so the cost only exists mid-capture and buys visibility into short-lived files) starts a bounded watch window that answers "who is writing to disk, and to which files?" — entirely from passive reads, with no strace, no ptrace, and no locks (`FileActivityCapture` in `src/file-activity.ts`, driven by the shared `CaptureManager`). Requires a Linux `/proc` filesystem; other platforms get 501. Each sample collects:

1. **Process totals** — `/proc/self/io` `read_bytes`/`write_bytes`, the anchor every per-file estimate is checked against.
2. **Open-file inventory** — readdir `/proc/self/fd`, readlink each entry, open flags from `/proc/self/fdinfo` (read/write/append). Regular files only; sockets, pipes, anon inodes, and deleted files are skipped. Files opened mid-capture join the watch set on the next sample.
3. **Per-file stat deltas** — size growth catches append writers (logs, JSON rewrites); mtime advancing with no size change is counted as an in-place rewrite (the signature of a wrapped SQLite WAL).
4. **SQLite WAL-index counters** — any watched file with a `-shm` sibling is treated as a WAL-mode database and its `-wal`/`-shm` siblings are pulled into the watch set. The wal-index header is read directly from the `-shm` file (no SQLite library): `iChange` (offset 8, one increment per committed transaction), `mxFrame` (offset 16, WAL frames since last checkpoint — a decrease means a checkpoint ran), and the encoded u16 page size (offset 14). The header's two 48-byte copies are compared to reject torn reads, and counter diffs are `>>> 0` for wraparound.

The report (`FilesReport` in `src/shared/types.ts`, stored like every capture with the raw per-sample series as `<id>.filesprofile`) contains: process-wide totals; per-file rows (bucket, mode, kind, size, growth, mtime changes, in-place rewrites); per-database rows (page size, commits + commits/s, frames written, checkpoints, estimated write bytes = frames × (page + 24-byte frame header) + checkpointed pages, and a "consider batching" note at ≥ 1 sustained commit/s — per-commit fsync amplification is the usual hidden cost); and a per-bucket **attribution table honesty-checked against the kernel total** — bytes the per-file model can't explain (fsync amplification, filesystem metadata, unwatched writers) appear as an explicit `(unattributed)` row instead of being hidden.

Path attribution mirrors the profile bucketing, keyed on data paths instead of source URLs (`bucketForDataPath` in `src/attribution.ts`): `plugin-config-data/<plugin>/` → that plugin, `node_modules/<pkg>/` → that package, files in any other non-core first-level folder under the config root → that folder's name — plugins keep local storage in folders they name themselves (`signalk-charts-provider-simple` writes to `~/.signalk/charts-simple/…`), so the folder name, not a plugin-list lookup, is the honest label. The server's own first-level entries (serverstate/, applicationData/, resources/, logs/, hidden dirs, top-level files like settings.json) → `signalk-server (core)`, everything outside the config root → `(other)`.

---

## HTTP API

All routes registered via `registerWithRouter` directly on the router (`src/routes.ts`) — **admin-only by default** under the server's security strategy. Base: `/plugins/signalk-performance-monitor/`.

| Method | Route                 | Description                                                                                                             |
| ------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/metrics`            | Latest metrics snapshot (JSON)                                                                                          |
| GET    | `/http-requests`      | Last 100 requests (newest first) + cumulative per-path aggregates                                                       |
| POST   | `/profile`            | Start CPU capture; returns `{ id }`; 409 if any capture is running; 400 on invalid duration/interval                    |
| GET    | `/profile`            | `{ running, profiles }` — status of any in-flight capture (with `remainingSeconds`) + stored list (with `rawSizeBytes`) |
| GET    | `/profile/:id/report` | Aggregated per-plugin report (CPU or heap); 404 if unknown                                                              |
| GET    | `/profile/:id/raw`    | Raw profile as `.json` attachment (opens in Chrome DevTools / speedscope)                                               |
| DELETE | `/profile/:id`        | Delete a stored profile; 204 on success, 404 if unknown                                                                 |
| POST   | `/heap-profile`       | Start allocation capture, same shape (`samplingIntervalBytes` instead of `samplingIntervalUs`)                          |
| POST   | `/files-profile`      | Start file activity capture (`sampleIntervalSeconds`, default 0.1); 501 without a Linux `/proc`                         |

Behavioral details:

- `registerWithRouter` is called before `start()`, so every handler resolves its dependencies per request and answers 503 until the plugin has started (and after it stops).
- Profile ids are validated against the `cpu-`/`heap-` id pattern before touching disk; malformed ids get 400.
- Unexpected handler errors are logged via `app.error` and returned as 500.

## Configuration schema

Defined in `src/plugin.ts` with titles, descriptions, and minimums; defaults:

```json
{
  "publishIntervalSeconds": { "type": "number", "default": 5, "minimum": 1 },
  "publishDeltas": { "type": "boolean", "default": true },
  "defaultProfileDurationSeconds": { "type": "number", "default": 30, "minimum": 1 },
  "maxProfileDurationSeconds": { "type": "number", "default": 120, "minimum": 1 },
  "samplingIntervalUs": { "type": "number", "default": 1000, "minimum": 100 },
  "samplingIntervalBytes": { "type": "number", "default": 32768, "minimum": 1024 },
  "filesSampleIntervalSeconds": { "type": "number", "default": 0.1, "minimum": 0.01 },
  "maxStoredProfiles": { "type": "number", "default": 5, "minimum": 1 },
  "httpRequestsEnabled": { "type": "boolean", "default": true },
  "httpLatestRequestsLimit": { "type": "number", "default": 200, "minimum": 0 },
  "httpAggregateRequestsLimit": { "type": "number", "default": 1000, "minimum": 0 }
}
```

`maxStoredProfiles` applies per profile type (5 CPU + 5 heap + 5 files). The memory (heap) and filesystem sampling intervals default from config (`samplingIntervalBytes`, `filesSampleIntervalSeconds`) and remain overridable per capture request. The HTTP request limits (`httpLatestRequestsLimit` newest entries, `httpAggregateRequestsLimit` per-path rows) treat 0 as unlimited, and `httpRequestsEnabled: false` turns request recording off entirely (see Feature 1).

## Webapp

React single-page app (`webapp/`), built with Vite into static assets under `public/` (auto-mounted at `/signalk-performance-monitor` via the `signalk-webapp` keyword):

- **Stack:** React 18, TypeScript, Vite. Runtime dependencies are React + ReactDOM plus the headless TanStack table core for the request tables (all bundled at build time — nothing beyond `dist/` + `public/` ships in the package); no charting library, no heavyweight UI frameworks.
- **Live metrics tiles** (`MetricsTiles`) — loop delay p50/p99/max, ELU, GC pause, heap, RSS, CPU, HTTP request rate + duration p50/p99/max, disk read/write byte rates, involuntary context switches, major page faults — polled from `GET /metrics` every 2s.
- **Profiling controls** (`ProfileControls`) — duration selector (10/30/60/120s) with separate "Profile CPU", "Profile Memory", and "Profile Filesystem" buttons; while a capture runs it shows type, seconds remaining, and a progress bar. Profile list polling runs at 5s normally and speeds up to 1s during a capture.
- **Profile list** (`ProfileList`) — stored captures with select, raw download, and delete.
- **HTTP requests** (`HttpRequests`) — tabbed card in its own section below Profiling, polled from `GET /http-requests` every 5s: the last 100 requests and the per-path aggregates as sortable (click a header), searchable tables via the shared `DataTable` component (headless `@tanstack/react-table`), styled like every other table. A default-on "Hide this plugin" toggle filters out the webapp's own polling, which would otherwise dominate the latest-requests view.
- **Report view** (`ReportView`) — per-plugin table (bucket, %, bar) rendering both CPU and heap reports, with expandable top-functions per bucket. File activity reports render through `FilesReportView` in two tabs: **Summary** (process totals, the write-attribution table with the `(unattributed)` honesty row, SQLite database stats — commits/s, WAL frames, checkpoints, batching notes — and the changed-files table, idle open files folded into a count) and **Individual Files** (every watched file with all of its stats in a sortable, searchable table via the shared `DataTable`, with a Download button exporting the current view as JSON; on the Summary tab, Download exports the full report).
- **Flame graph** (`FlameGraph`) — in-browser icicle flame graph for both report types, built from the report's `flame` tree with no charting library. Click a frame to zoom (ancestors stay as dimmed full-width context), hover or keyboard-focus for a tooltip (value, % of view / % of capture, function, bucket, url), legend above the graph. Frames are colored by attribution bucket: four hues validated for arbitrary adjacency on the app's light surface (signalk core pinned to blue, top packages get orange/aqua/violet), everything else in neutral grays. Frame names render inline only when they measurably fit; identity never relies on color alone (labels, tooltip, and the bucket table below).
- API client (`webapp/src/api.ts`) maps 401/403 to an "Admin login required" banner; shared types are imported directly from `src/shared/types.ts` so the API contract is compile-time checked.

## Plugin lifecycle

- `start(options)`: merge options over defaults, start the metrics collector (plus a baseline sample), create the profile store and capture manager, emit the units meta delta, start the publish interval.
- `stop()`: clear timers, abort any in-flight capture (discarding it) and disconnect the inspector session, stop the collector, set status "Stopped". Routes answer 503 afterward.
- `setPluginStatus`: idle → "Monitoring (loop p99: Xms)" (refreshed each publish); capturing → "Profiling: Ns remaining" / "Heap profiling: Ns remaining" / "Filesystem profiling: Ns remaining", ticked every second.

## Security considerations

- Profiles reveal file paths and function names — admin-only routes (the default) are required, not optional.
- The inspector session is in-process and self-connected; it does **not** open a debug port. No new attack surface beyond what an admin-installed plugin already has.
- Capture duration and stored profile count are capped to bound CPU and disk on small devices; profile ids are pattern-validated so route parameters can never traverse outside the data dir.

## Known limitations

- Main thread only; native addon internals appear as `(program)`/unresolved.
- Sampling at 1ms misses rare sub-millisecond functions; statistically sound for anything that matters at sustained load.
- One capture at a time (shared across CPU, heap, and files); a plugin restart aborts and discards an in-flight capture.
- Report buckets depend on file paths; a plugin that bundles dependencies absorbs their cost into its own bucket (arguably correct).
- File activity capture is Linux-only (`/proc`), which covers the Raspberry Pi installs it exists for. Its per-database write volume is an estimate — a floor that excludes fsync amplification — which is exactly why the report keeps the `(unattributed)` remainder visible. Deleted-but-open files and sub-sample-interval writers can escape the per-file tables; the process totals still include them.

## Development Practices

**Test-driven development.** Tests were written before or alongside the code they cover; all layers run via Vitest:

- **Unit tests** (`test/`) — URL → bucket attribution against a fixture `.cpuprofile` (scoped packages, nested `node_modules`, file URLs vs paths, synthetic frames); metrics collection; profile store rotation/cleanup/id validation; capture manager overlap/abort.
- **Integration tests** (`test/routes.test.ts`) — HTTP routes exercised with supertest against an Express router and faked capture/store dependencies (capture start, 409 on overlap, duration caps, list/report/raw/delete, 503 before start).
- **Component tests** (`webapp/src/*.test.tsx`) — React Testing Library (jsdom) for the metrics tiles, app flow, and report table, rendered from fixture API responses.

**TypeScript.** Everything is `strict: true` — backend (`tsconfig.json` → `dist/`, the package `main`), tests (`test/tsconfig.json`), and webapp (`webapp/tsconfig.json`, `tsc --noEmit` + Vite bundle). Shared API types live in `src/shared/types.ts` and are imported by both backend and webapp.

**Linting & formatting.** ESLint (typescript-eslint + React plugins) flat config and Prettier:

- `husky` + `lint-staged` pre-commit hook runs `eslint --max-warnings 0` and `prettier --check` on staged files — check-only, no auto-fixing: a violation fails the commit and the developer fixes it explicitly (`npm run lint:fix` / `npm run format`).
- Scripts: `npm test` (backend + webapp), `npm run typecheck` (all three tsconfigs), `npm run lint`, `npm run format:check`, `npm run build` (plugin + webapp).

**CI/CD** (`.github/workflows/`):

- `test.yml` — on every push and PR, Node 20 and 22 matrix: typecheck, lint, format check, full test suite, build.
- `publish.yml` — on GitHub release, publishes to npm via OIDC trusted publishing (no `NPM_TOKEN` secret); `prepublishOnly` rebuilds plugin and webapp.

## Milestones

All shipped as of v0.5.0:

1. **v0.1** — metrics collection + delta publishing + `/metrics` route. ✅
2. **v0.2** — CPU capture + raw `.cpuprofile` storage/download. ✅
3. **v0.3** — per-plugin aggregation report + React webapp. ✅
4. **v0.4** — allocation profiling. ✅
5. **v0.5** — in-browser flame graph for CPU and allocation reports. ✅

## Future work

- Loop-delay alerting via Signal K notifications.
- Optionally graduate always-on gauges into server core (`deltastats.ts`) as a separate PR, with this plugin as evidence.

---

## Implementation note

The per-plugin attribution logic (URL → bucket) was the piece with real edge cases (scoped packages, nested `node_modules`, file URLs vs paths, source checkouts, synthetic frames) — and, as predicted, the poster child for the TDD approach: it lives in `src/attribution.ts` behind fixture-driven tests in `test/attribution.test.ts`. The rest is mostly plumbing across `src/metrics.ts` (collection), `src/deltas.ts` (delta shaping), `src/capture.ts` (inspector sessions), `src/store.ts` (rotation), `src/routes.ts` (HTTP), and `src/plugin.ts` (lifecycle wiring).
