import type { ReactNode } from 'react'

/**
 * Static help panels: how to drive the plugin, a glossary of every term
 * shown in the UI, and guidance for reading the numbers. Collapsed by
 * default so the docs don't crowd the live data.
 */

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="collapse-arrow collapse border border-base-300 bg-base-100 shadow-sm">
      <summary className="collapse-title font-medium">{title}</summary>
      <div className="collapse-content flex flex-col gap-3 text-sm leading-relaxed text-base-content/80">
        {children}
      </div>
    </details>
  )
}

function Term({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-semibold text-base-content">{name}</dt>
      <dd>{children}</dd>
    </>
  )
}

export function Documentation() {
  return (
    <div className="flex flex-col gap-2">
      <Panel title="How to use this plugin">
        <p>
          The live metrics above are always on and update every few seconds; collecting them costs
          next to nothing. The same values are published as Signal K deltas under{' '}
          <code>performance.*</code>, so you can chart them with <code>signalk-to-influxdb</code>
          /Grafana or wire them into alerting plugins.
        </p>
        <p>
          When a number looks wrong, capture a profile to find out who is responsible. Pick a
          duration long enough to cover the symptom, then <strong>Profile CPU</strong> (where
          processor time goes) or <strong>Profile Memory</strong> (which code allocates). The server
          keeps serving throughout — the sampling profiler adds a few percent of overhead only while
          the capture runs.
        </p>
        <p>
          Finished captures appear in the list. <strong>Report</strong> opens the per-plugin
          breakdown and flame graph (click again to close), <strong>Download</strong> saves the raw
          profile as <code>.json</code> for Chrome DevTools or{' '}
          <a className="link" href="https://www.speedscope.app/" target="_blank" rel="noreferrer">
            speedscope
          </a>
          , and <strong>Delete</strong> removes it. The oldest capture of each type is dropped
          automatically once the configured limit is reached.
        </p>
        <p>
          Two habits pay off: profile while the problem is actually happening, and keep one capture
          from a calm period as a baseline to compare against.
        </p>
      </Panel>

      <Panel title="What the terms mean">
        <dl className="flex flex-col gap-x-4 gap-y-1 sm:grid sm:grid-cols-[max-content_1fr]">
          <Term name="Loop delay (p50 / p99 / max)">
            Signal K runs everything — delta processing, WebSockets, every plugin — on a single
            event loop. Delay measures how late that loop gets to scheduled work, i.e. how long
            something blocked it. p50 is the typical sample, p99 the near-worst (99% of samples were
            faster), max the single worst stall since the last update.
          </Term>
          <Term name="Loop utilization">
            The share of time the event loop spent busy executing JavaScript rather than idle
            waiting for work. Values near 100% mean no headroom left.
          </Term>
          <Term name="CPU">
            Process CPU time divided by wall-clock time over the last interval — roughly how much of
            one processor core the whole server is using.
          </Term>
          <Term name="GC pause / interval">
            Time spent paused for JavaScript garbage collection during the last publish interval.
            Persistently high values indicate heavy allocation churn.
          </Term>
          <Term name="Heap used / RSS">
            Heap used is the memory held by live JavaScript objects. RSS (resident set size) is the
            total RAM footprint of the server process — heap plus buffers, native code, and the
            JavaScript engine&apos;s own overhead.
          </Term>
          <Term name="HTTP req p99 / HTTP requests">
            How many HTTP requests the server handled per second, and how long they took (p50
            typical, p99 near-worst, max the single slowest). Covers every request into the server —
            REST API, admin UI, webapps — but not WebSocket traffic. All zero simply means no
            requests arrived during the interval.
          </Term>
          <Term name="HTTP Requests (Latest / Aggregate)">
            The Latest tab lists the last 100 requests the server handled — any client, not just
            this webapp — with query strings intact. The Aggregate tab totals every request per path
            (query strings stripped) since the plugin started; its Duration and Size columns are
            per-request averages. Size is the response&apos;s declared <code>Content-Length</code>;
            streamed responses don&apos;t declare one and show a dash. Durations are color-coded:
            green under 25 ms, blue to 50 ms, orange to 100 ms, orange-red to 200 ms, and red
            beyond. Click a column header to sort, and use the search box to filter. WebSocket
            traffic is not included.
          </Term>
          <Term name="Disk writes / reads">
            Storage I/O caused by the server process, counted in the kernel&apos;s 512-byte block
            units — 2,000 writes/s is roughly 1 MB/s. Reads count only page-cache misses, i.e. data
            actually fetched from disk, so a steady zero is normal and healthy on a warmed-up
            server. Writes come from logging, plugin databases, and state files; a sustained jump
            usually means a plugin started writing heavily.
          </Term>
          <Term name="Ctx switches (invol.)">
            How often per second the operating system preempted the server to run something else.
            Persistently high values mean other processes are competing for the CPU — the server is
            slow because the machine is busy, not because of its own code.
          </Term>
          <Term name="Major page faults">
            How often per second the server had to wait for memory to be read back from disk.
            Anything persistently above zero means the system is short on RAM and swapping — expect
            stalls that no CPU profile will explain.
          </Term>
          <Term name="CPU profile">
            A statistical capture that samples the call stack every 1 ms by default. Time per
            function is estimated from how often it appears in the samples.
          </Term>
          <Term name="Memory profile">
            Samples the allocating call stack roughly every 32 KiB allocated (by default). It
            measures memory allocated during the capture — including memory freed since — not what
            is currently held.
          </Term>
          <Term name="Bucket">
            Who a cost is attributed to, decided by source file: an npm package (usually a plugin),{' '}
            <code>signalk-server (core)</code>, <code>node runtime</code>, or the engine&apos;s
            synthetic frames — <code>(idle)</code> for time with nothing to do,{' '}
            <code>(garbage collector)</code>, and <code>(program)</code> for engine-internal work.
          </Term>
          <Term name="Self time / self memory">
            The cost of a function&apos;s (or bucket&apos;s) own code, excluding functions it
            called.
          </Term>
          <Term name="Flame graph">
            The capture&apos;s call tree with the root at the top. A frame&apos;s width is its total
            cost — self plus everything called beneath it — and its color follows the bucket legend.
            Click a frame to zoom into it, click an ancestor or Reset zoom to zoom back out, and
            hover (or focus with the keyboard) for exact numbers.
          </Term>
        </dl>
      </Panel>

      <Panel title="How to interpret the data">
        <p>
          A healthy server is mostly idle: loop-delay p99 of a few milliseconds, low loop
          utilization, and <code>(idle)</code> dominating CPU reports. Loop delay is the number your
          clients feel — because everything shares one loop, a 200 ms stall pauses every WebSocket
          and REST consumer at once.
        </p>
        <p>
          High loop delay with <em>low</em> CPU points at occasional long synchronous work (a big
          file read, parsing a huge JSON payload): watch the max value and use a longer capture to
          catch the culprit in the act. High loop delay with <em>high</em> utilization and CPU is
          plain overload — the CPU report&apos;s bucket table shows which plugin to blame.
        </p>
        <p>
          In a report, the share bars rank the buckets; expand a row to see its hottest functions. A
          big <code>(idle)</code> share is good. A noticeable <code>(garbage collector)</code> share
          means allocation churn — run a Memory profile to see who allocates.
        </p>
        <p>
          For suspected memory leaks, watch heap used over hours (the published deltas make this
          easy in Grafana). An allocation profile shows who allocates during the capture — heavy
          allocators and leakers are usually the same code, but confirm against the long-term trend.
          RSS sitting well above heap used is normal on its own, not a leak.
        </p>
        <p>
          Keep the limits in mind: the numbers are statistical estimates from sampling, so rare
          sub-millisecond functions can be missed entirely; only the server&apos;s main thread is
          profiled (child processes are invisible); and a plugin that bundles its dependencies
          absorbs their cost into its own bucket.
        </p>
      </Panel>

      <Panel title="Opening a profile in another app">
        <p>
          The <strong>Download</strong> button saves a standard V8 profile — CPU captures use
          Chrome&apos;s <code>.cpuprofile</code> format, memory captures the{' '}
          <code>.heapprofile</code> format — so any tool that reads Chrome profiler output can open
          it. The one extra <code>signalk-performance-monitor</code> key holds capture metadata;
          other tools ignore it, and it is what lets <strong>Upload</strong> restore the profile
          here.
        </p>
        <p>
          <a className="link" href="https://www.speedscope.app/" target="_blank" rel="noreferrer">
            speedscope
          </a>{' '}
          is the quickest look at a CPU capture: drag the downloaded <code>.json</code> onto the
          page as-is. Its Left Heavy and Sandwich views merge repeated call paths, which the flame
          graph here doesn&apos;t do, and the profile never leaves your browser. It cannot read
          memory captures.
        </p>
        <p>
          Chrome (or Edge) DevTools opens both, but its file pickers filter by extension, so rename
          the download first: <code>cpu-….json</code> to <code>cpu-….cpuprofile</code>,{' '}
          <code>heap-….json</code> to <code>heap-….heapprofile</code>. For CPU, open DevTools on any
          page, then <em>⋮ → More tools → JavaScript Profiler → Load</em>. For memory, use the{' '}
          <em>Memory</em> panel&apos;s <em>Load</em> button — the capture appears as an allocation
          sampling profile.
        </p>
        <p>
          VS Code opens both formats after the same rename — just open the file for a sortable
          table, or install the <em>Flame Chart Visualizer for JavaScript Profiles</em> extension
          for a flame chart. Function locations point at paths on the server, so jumping to source
          only works where the code also exists locally.
        </p>
        <p>
          To skip the renaming, copy captures straight off the server: they are stored with the
          correct extensions in the plugin&apos;s data directory,{' '}
          <code>~/.signalk/plugin-config-data/signalk-performance-monitor/</code>.
        </p>
      </Panel>
    </div>
  )
}
