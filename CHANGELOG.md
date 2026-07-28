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
