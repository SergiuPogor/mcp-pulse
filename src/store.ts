/**
 * mcp-pulse: In-memory store with sliding window metrics
 */

import type {
  MCPCall,
  MCPServer,
  Alert,
  AlertConfig,
  MetricsSummary,
  TimeSeriesPoint,
  ToolStat,
  CallStatus,
  WSEvent,
} from './types.js';
import { v4 as uuid } from 'uuid';

const SENSITIVE_KEYS = new Set([
  'token', 'api_key', 'apiKey', 'secret', 'password', 'auth',
  'authorization', 'bearer', 'credential', 'private_key', 'privateKey',
]);

function redact(obj: unknown): unknown {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const rec = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
  }
  return out;
}

export class PulseStore {
  private calls = new Map<string, MCPCall>();
  private servers = new Map<string, MCPServer>();
  private alerts: Alert[] = [];
  private seq = 0;
  private alertCooldowns = new Map<string, number>(); // alertId → last fired timestamp

  constructor(private maxCalls = 100_000) {}

  // ─── Servers ────────────────────────────────────────────────────────────

  upsertServer(server: MCPServer): void {
    this.servers.set(server.id, server);
  }

  getServer(id: string): MCPServer | undefined {
    return this.servers.get(id);
  }

  getServers(): MCPServer[] {
    return Array.from(this.servers.values());
  }

  updateServerActivity(serverId: string): void {
    const server = this.servers.get(serverId);
    if (server) {
      server.lastActivityAt = new Date().toISOString();
      this.servers.set(serverId, server);
    }
  }

  // ─── Calls ────────────────────────────────────────────────────────────────

  addCall(call: MCPCall): void {
    // Sanitize
    const sanitized: MCPCall = {
      ...call,
      request: {
        ...call.request,
        params: call.request.params ? redact(call.request.params) as Record<string, unknown> : undefined,
      },
      response: call.response ? { ...call.response } : undefined,
    };

    this.calls.set(call.id, sanitized);
    this.updateServerOnCall(sanitized);
    this.trim();
    this.updateTimeseries();
  }

  getCall(id: string): MCPCall | undefined {
    return this.calls.get(id);
  }

  getCalls(opts: {
    serverId?: string;
    tool?: string;
    status?: CallStatus;
    limit?: number;
    offset?: number;
    from?: string;
    to?: string;
  } = {}): MCPCall[] {
    let result = Array.from(this.calls.values());

    if (opts.serverId) result = result.filter(c => c.serverId === opts.serverId);
    if (opts.tool) result = result.filter(c => c.tool === opts.tool);
    if (opts.status) result = result.filter(c => c.status === opts.status);
    if (opts.from) result = result.filter(c => c.timestamp >= opts.from!);
    if (opts.to) result = result.filter(c => c.timestamp <= opts.to!);

    result.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    return result.slice(offset, offset + limit);
  }

  getCallsCount(opts: Partial<{serverId: string; tool: string; status: CallStatus}> = {}): number {
    return this.getCalls({ ...opts, limit: Infinity, offset: 0 }).length;
  }

  // ─── Metrics ─────────────────────────────────────────────────────────────

  getMetrics(since?: string): MetricsSummary {
    const calls = since ? this.getCalls({ from: since }) : Array.from(this.calls.values());
    const now = new Date();
    const windowStart = since ? new Date(since) : new Date(now.getTime() - 60 * 60 * 1000);

    const totalCalls = calls.length;
    const totalErrors = calls.filter(c => c.status === 'error').length;
    const errorRate = totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;

    const latencies = calls.map(c => c.duration).sort((a, b) => a - b);
    const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const latencyP50 = this.percentile(latencies, 50);
    const latencyP95 = this.percentile(latencies, 95);
    const latencyP99 = this.percentile(latencies, 99);

    // Calls per minute
    const recentCalls = calls.filter(c => {
      const d = new Date(c.timestamp);
      return d.getTime() >= now.getTime() - 60 * 1000;
    });
    const callsPerMinute = recentCalls.length;

    // Top tools
    const toolMap = new Map<string, ToolStat>();
    for (const call of calls) {
      const key = `${call.serverId}:${call.tool}`;
      const existing = toolMap.get(key) ?? {
        tool: call.tool,
        serverId: call.serverId,
        calls: 0,
        errors: 0,
        avgLatency: 0,
        errorRate: 0,
      };
      existing.calls++;
      if (call.status === 'error') existing.errors++;
      existing.avgLatency = (existing.avgLatency * (existing.calls - 1) + call.duration) / existing.calls;
      existing.errorRate = (existing.errors / existing.calls) * 100;
      toolMap.set(key, existing);
    }
    const topTools = Array.from(toolMap.values())
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 20);

    return {
      totalCalls,
      totalErrors,
      errorRate: Math.round(errorRate * 100) / 100,
      avgLatency: Math.round(avgLatency * 100) / 100,
      latencyP50: Math.round(latencyP50 * 100) / 100,
      latencyP95: Math.round(latencyP95 * 100) / 100,
      latencyP99: Math.round(latencyP99 * 100) / 100,
      callsPerMinute,
      activeServers: this.servers.size,
      topTools,
      periodStart: windowStart.toISOString(),
      periodEnd: now.toISOString(),
    };
  }

  getTimeseries(windowMinutes = 60): TimeSeriesPoint[] {
    const now = Date.now();
    const buckets = new Map<number, TimeSeriesPoint>();

    // Initialize buckets
    for (let i = 0; i < windowMinutes; i++) {
      const ts = new Date(now - (windowMinutes - i) * 60 * 1000);
      const key = Math.floor(ts.getTime() / 60000) * 60000;
      buckets.set(key, { timestamp: new Date(key).toISOString(), calls: 0, errors: 0, latencyAvg: 0, latencyP99: 0 });
    }

    const cutoff = new Date(now - windowMinutes * 60 * 1000);
    for (const call of this.calls.values()) {
      if (new Date(call.timestamp) < cutoff) continue;
      const key = Math.floor(new Date(call.timestamp).getTime() / 60000) * 60000;
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.calls++;
      if (call.status === 'error') bucket.errors++;
    }

    return Array.from(buckets.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // ─── Alerts ──────────────────────────────────────────────────────────────

  evaluateAlerts(configs: AlertConfig[]): Alert[] {
    const fired: Alert[] = [];
    const metrics = this.getMetrics();

    for (const config of configs) {
      if (!config.enabled) continue;

      // Check cooldown
      const lastFired = this.alertCooldowns.get(config.id) ?? 0;
      if (Date.now() - lastFired < config.cooldown * 1000) continue;

      let value = 0;
      switch (config.metric) {
        case 'error_rate': value = metrics.errorRate; break;
        case 'latency_p50': value = metrics.latencyP50; break;
        case 'latency_p95': value = metrics.latencyP95; break;
        case 'latency_p99': value = metrics.latencyP99; break;
        case 'calls_per_min': value = metrics.callsPerMinute; break;
      }

      if (value >= config.threshold) {
        this.alertCooldowns.set(config.id, Date.now());
        const alert: Alert = {
          id: uuid(),
          alertId: config.id,
          name: config.name,
          metric: config.metric,
          value,
          threshold: config.threshold,
          window: config.window,
          severity: config.severity,
          message: `${config.name}: ${config.metric}=${value} (threshold: ${config.threshold})`,
          firedAt: new Date().toISOString(),
        };
        this.alerts.push(alert);
        fired.push(alert);
      }
    }

    return fired;
  }

  getAlerts(limit = 50): Alert[] {
    return this.alerts.slice(-limit);
  }

  // ─── WebSocket Events ─────────────────────────────────────────────────────

  nextSeq(): number {
    return ++this.seq;
  }

  makeEvent<T>(type: WSEvent['type'], payload: T): WSEvent<T> {
    return {
      type,
      payload,
      seq: this.nextSeq(),
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  private updateServerOnCall(call: MCPCall): void {
    const server = this.servers.get(call.serverId);
    if (!server) return;
    server.calls++;
    server.lastActivityAt = call.timestamp;
    if (call.status === 'error') server.errors++;
    const prevAvg = server.avgLatency;
    const prevCalls = server.calls - 1;
    server.avgLatency = prevCalls > 0 ? (prevAvg * prevCalls + call.duration) / server.calls : call.duration;
    this.servers.set(call.serverId, server);
  }

  private updateTimeseries(): void {
    // recomputed on demand — no need to store
  }

  private trim(): void {
    if (this.calls.size <= this.maxCalls) return;
    const entries = Array.from(this.calls.entries())
      .sort((a, b) => a[1].timestamp.localeCompare(b[1].timestamp));
    const toRemove = entries.slice(0, this.calls.size - this.maxCalls);
    for (const [id] of toRemove) this.calls.delete(id);
  }
}
