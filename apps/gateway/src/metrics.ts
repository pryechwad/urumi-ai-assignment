// Per-replica Prometheus metrics. The dashboard's numbers come from the audit log in Postgres
// (shared across replicas); these counters are for scraping.
const BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

export class Metrics {
  private calls = new Map<string, number>(); // `${server}|${outcome}` -> count
  private latency = new Map<string, Series>(); // server -> histogram
  private up = new Map<string, number>();

  recordCall(server: string, outcome: string, durationMs: number) {
    const key = `${server}|${outcome}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    let s = this.latency.get(server);
    if (!s) {
      s = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      this.latency.set(server, s);
    }
    s.count++;
    s.sum += durationMs;
    BUCKETS.forEach((b, i) => {
      if (durationMs <= b) s.buckets[i]++;
    });
  }

  setUp(server: string, isUp: boolean) {
    this.up.set(server, isUp ? 1 : 0);
  }

  render(): string {
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const lines: string[] = [];
    lines.push("# HELP mcp_gateway_tool_calls_total Tool calls handled by this replica.");
    lines.push("# TYPE mcp_gateway_tool_calls_total counter");
    for (const [key, n] of this.calls) {
      const [server, outcome] = key.split("|");
      lines.push(`mcp_gateway_tool_calls_total{server="${esc(server)}",outcome="${esc(outcome)}"} ${n}`);
    }
    lines.push("# HELP mcp_gateway_tool_call_duration_ms Tool call latency in milliseconds.");
    lines.push("# TYPE mcp_gateway_tool_call_duration_ms histogram");
    for (const [server, s] of this.latency) {
      BUCKETS.forEach((b, i) =>
        lines.push(`mcp_gateway_tool_call_duration_ms_bucket{server="${esc(server)}",le="${b}"} ${s.buckets[i]}`),
      );
      lines.push(`mcp_gateway_tool_call_duration_ms_bucket{server="${esc(server)}",le="+Inf"} ${s.count}`);
      lines.push(`mcp_gateway_tool_call_duration_ms_sum{server="${esc(server)}"} ${s.sum}`);
      lines.push(`mcp_gateway_tool_call_duration_ms_count{server="${esc(server)}"} ${s.count}`);
    }
    lines.push("# HELP mcp_gateway_upstream_up Whether the last health check of an upstream succeeded.");
    lines.push("# TYPE mcp_gateway_upstream_up gauge");
    for (const [server, v] of this.up) lines.push(`mcp_gateway_upstream_up{server="${esc(server)}"} ${v}`);
    return lines.join("\n") + "\n";
  }
}
