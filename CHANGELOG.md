# v1.4.0

- Live metric tiles are color-coded green/orange/red by classic Node health thresholds — loop delay p99 at 50/100 ms, the conventional 70%/90% utilization bands for ELU and CPU, GC pause time at 5%/10% of the publish interval, heap against the ~1.5 GB default old-space limit, and HTTP p99 per Apdex (0.5 s / 2 s). Status never rides on hue alone: orange values carry a triangle icon, red an octagon, plus screen-reader warning/critical text, and all colors are contrast-checked against both themes
- New plugin config options with the previous hardcoded values as defaults: memory profiler sampling interval (`samplingIntervalBytes`), filesystem capture sample interval (`filesSampleIntervalSeconds`), HTTP table caps (`httpLatestRequestsLimit` / `httpAggregateRequestsLimit`, 0 = unlimited), and `httpRequestsEnabled` to switch per-request tracking off entirely — when disabled the PerformanceObserver never subscribes so per-request cost is zero, and the webapp shows a "recording is turned off" note
- HTTP request tracking upgrades: the recent-requests buffer grows from 100 to 200 and records request headers behind a per-row inspect toggle, a Reset button clears latest and aggregate tracking, and resource entry/tile paths (charts, routes, waypoints…) collapse to their resource type so they no longer flood the aggregate table
- The aggregate HTTP table is capped at 1000 distinct method+path rows (up from 500), evicting the least-recently-seen row when a new path arrives at capacity — so a scanner walking random URLs can't grow the map for the life of the server, while steady-state traffic to known paths pays nothing
- HTTP table styling: methods render as soft colored pills, status codes are color-coded by hundred-block (2xx green, 3xx blue, 4xx amber, 5xx red), and the Errors column sits next to Requests on the aggregate tab
- "File profiling" is renamed to "filesystem profiling" across the UI, plugin status, and docs, and the stored profiles list now renders profile types as soft color-coded badges (CPU violet, Memory blue, Filesystem green)
- CI fixes: test fixtures no longer hardcode `/home` paths, proc-layout symlink tests are skipped on Windows, and webapp tests get a longer timeout under QEMU emulation; new app-store screenshots

# v1.3.0

- Byte-accurate disk I/O metrics: `performance.disk.readRate/writeRate` now report true bytes per second from `/proc/self/io` (the kernel's count of bytes the process caused to hit storage) instead of 512-byte block counts, with the block-count estimate kept as a fallback for non-Linux hosts; delta units metadata, webapp tiles, and glossary updated to match
- File activity profiling: a new "Profile Files" capture watches every file the server has open (from `/proc/self/fd`, with open modes from `fdinfo`) over a bounded window — size growth catches append writers, mtime-without-growth catches in-place churn, and SQLite databases are read passively through their WAL-index (`-shm`) headers for per-database commit rates, WAL frames, checkpoints, and estimated write volume, with a "consider batching" note for sustained per-commit-fsync workloads
- File activity reports attribute estimated writes per plugin (`plugin-config-data/<plugin>/` paths, plugin storage folders like `~/.signalk/charts-simple/` bucketed by folder name, node_modules packages, server core) and honesty-check the sum against the kernel's process-wide counter, reporting the gap as an explicit `(unattributed)` row; reports are stored, viewable, downloadable (raw per-sample series as JSON), and deletable like every other capture
- File activity reports render in two tabs: Summary (attribution, databases, changed files) and Individual Files — every watched file with all of its stats in a sortable, searchable table with a JSON download of the current view, built on the same table machinery as the HTTP request tables. Paths in both tabs display relative to the Signal K data directory with bucket/mode/kind as colored badges under each filename and a copy-full-path button (with a plain-HTTP clipboard fallback), and a default-on "Hide readonly files" filter keeps the writers in focus
- Downloaded file profiles can be re-uploaded like CPU and memory profiles: the report is rebuilt by replaying the raw sample series through the same aggregation a live capture uses, with duration and sample interval recovered from the samples when the embedded metadata is missing
- New admin-only `POST /files-profile` route (`{ duration?, sampleIntervalSeconds? }`, 501 on non-Linux hosts) sharing the one-capture-at-a-time slot with CPU and memory profiling; sampling defaults to 100 ms — captures are on-demand and bounded, so the faster rate costs nothing outside a capture while catching short-lived files and WAL checkpoints that 1 s sampling would miss

# v1.2.0

- HTTP request tracking: a ring buffer of the last 100 requests (method, path with query string, status, duration, response size) plus cumulative per-method+path aggregates (count, average/max/total duration, errors, bytes), observed from the same `http` performance entries as the metrics collector and served by a new admin-only `GET /http-requests` route
- New HTTP Requests section in the webapp with Latest and Aggregate tabs: sortable, searchable tables with pagination, GET paths linked to the live URL, duration heat colors, a default-on "Hide this plugin" toggle, and a Download button exporting the current view (sorted and filtered) as timestamped JSON
- Profile button tweaks: "JSON" renamed to "Download", "Upload" to "Upload Profile", and View/Download button colors swapped

# v1.1.0

- HTTP request timing metrics: `performance.http.requestRate` and `performance.http.requestDuration.p50/p99/max`, measured via a PerformanceObserver on `http` entries — every inbound request the server handles is timed with zero instrumentation and no cost while stopped
- Process resource usage metrics from `process.resourceUsage()`, diffed into per-second rates: `performance.disk.readRate/writeRate`, `performance.cpu.involuntaryContextSwitchRate`, and `performance.memory.majorPageFaultRate`; five new webapp tiles with glossary entries
- Profile upload: a green Upload button in the webapp restores a previously downloaded profile JSON and rebuilds its per-plugin report, auto-detecting CPU vs allocation profiles. Downloaded profiles now embed capture metadata (ignored by Chrome DevTools/speedscope), so download → upload is lossless
- Dark mode with a light/dark toggle next to the title — follows the browser's `prefers-color-scheme` by default, remembers an explicit choice, and applies it before first paint
- Docs panel explaining how to open downloaded profiles in external apps (speedscope, Chrome DevTools, VS Code)
- Profile download button renamed from "Raw" to "JSON"; downloads are served with a `.json` extension instead of `.cpuprofile`/`.heapprofile`
- CI fixes: force LF checkout for Windows runners, tolerate `rss` reporting 0 under QEMU emulation, and de-flake the delay-reset test
- Small wording and button styling tweaks in the webapp

# v1.0.0

Initial release.

- Always-on event-loop health metrics published as Signal K deltas every 5 s (configurable): event-loop delay p50/p99/max, event-loop utilization, GC pause time, heap/RSS, and process CPU utilization under the `performance.*` paths
- On-demand CPU profiling of the live server via a self-connected `node:inspector` session — the V8 sampling profiler runs off-thread with overhead only while capturing, and no debug port is opened
- Allocation profiling (sampling heap profiler) to see which plugin allocates most; full heap snapshots are deliberately not exposed (unsafe on memory-constrained hardware)
- Per-plugin attribution: every profile is post-processed into buckets — `<plugin package>`, `signalk-server (core)`, `node runtime`, `(idle)`, `(garbage collector)` — with the top functions per bucket by self-time
- Admin-only HTTP API on the plugin router: metrics snapshot, start CPU/heap captures, list stored profiles, per-plugin reports, raw `.cpuprofile`/`.heapprofile` download, and profile deletion
- Webapp with live stat tiles, one-click profiling, in-browser zoomable flame graphs (colored by plugin) for both CPU and allocation reports, per-plugin tables with share bars and expandable top functions, and raw profile download
- Documentation section in the webapp: usage, glossary, and how to read the data
- App icon and screenshots for the Signal K app store
