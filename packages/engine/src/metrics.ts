/** A tiny Prometheus registry: counters and histograms with labels, rendered in the text format. */

type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]!.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");

class Counter {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ""} ${v}`);
    return lines;
  }
}

class Histogram {
  readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {}
  observe(labels: Labels, value: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) this.series.set(k, (s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? "," : "";
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{${k}${sep}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ""} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ""} ${s.count}`);
    }
    return lines;
  }
}

export class Metrics {
  readonly startedAt = Date.now();
  readonly requests = new Counter("onstreak_http_requests_total", "HTTP requests by method, route and status.");
  readonly duration = new Histogram("onstreak_http_request_duration_seconds", "HTTP request duration in seconds.", [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]);
  readonly events = new Counter("onstreak_events_tracked_total", "Events tracked (duplicates not counted).");
  readonly webhooks = new Counter("onstreak_webhook_deliveries_total", "Webhook delivery attempts by result (delivered, retry, failed).");

  render(): string {
    const mem = process.memoryUsage();
    const gauges = [
      "# HELP onstreak_uptime_seconds Seconds since the process started.",
      "# TYPE onstreak_uptime_seconds gauge",
      `onstreak_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`,
      "# HELP onstreak_process_resident_memory_bytes Resident memory in bytes.",
      "# TYPE onstreak_process_resident_memory_bytes gauge",
      `onstreak_process_resident_memory_bytes ${mem.rss}`,
      "# HELP onstreak_process_heap_used_bytes V8 heap in use, in bytes.",
      "# TYPE onstreak_process_heap_used_bytes gauge",
      `onstreak_process_heap_used_bytes ${mem.heapUsed}`,
    ];
    return [...this.requests.render(), ...this.duration.render(), ...this.events.render(), ...this.webhooks.render(), ...gauges].join("\n") + "\n";
  }
}

/** A route label without ids: /v1/users/asha/quests becomes /v1/users/:id/quests. */
export function routeLabel(parts: string[]): string {
  if (parts.length === 0) return "/";
  if (parts[0] !== "v1") return `/${parts.join("/")}`.slice(0, 64);
  const literal = new Set(["batch", "preview", "deliveries"]);
  return (
    "/" +
    parts
      .map((p, i) => {
        if (i === 0 || i % 2 === 1) return p.slice(0, 32);
        return literal.has(p) ? p : ":id";
      })
      .join("/")
  );
}
