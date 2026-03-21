/**
 * mcp-pulse: Shared TypeScript types for the MCP observability platform
 */

// ─── Core Call Types ───────────────────────────────────────────────────────

export type CallStatus = 'success' | 'error' | 'timeout';
export type ProtocolMethod =
  | 'initialize'
  | 'tools/list'
  | 'tools/call'
  | 'tools/list_changed'
  | 'resources/list'
  | 'resources/read'
  | 'resources/subscribe'
  | 'resources/unsubscribe'
  | 'prompts/list'
  | 'prompts/get'
  | 'prompts/list_changed'
  | 'sampling/create'
  | 'roots/list'
  | 'roots/add'
  | 'roots/remove'
  | 'notifications/initialized'
  | 'notifications/tools/list_changed'
  | 'notifications/resources/list_changed'
  | 'notifications/prompts/list_changed'
  | 'cancel';

export interface CallRequest {
  method: ProtocolMethod;
  params?: Record<string, unknown>;
  id: string | number;
}

export interface CallResponse {
  content?: unknown[];
  isError?: boolean;
  error?: { code: number; message: string; data?: unknown };
}

export interface MCPCall {
  id: string;
  serverId: string;
  serverName: string;
  tool: string;
  method: ProtocolMethod;
  status: CallStatus;
  duration: number; // ms
  request: SanitizedRequest;
  response?: CallResponse;
  errorMessage?: string;
  errorStack?: string;
  timestamp: string; // ISO 8601
  size: number; // bytes estimate
}

export interface SanitizedRequest {
  method: ProtocolMethod;
  params?: Record<string, unknown>;
}

// ─── Server Types ────────────────────────────────────────────────────────────

export interface MCPServer {
  id: string;
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: ServerCapabilities;
  connectedAt: string;
  lastActivityAt: string;
  calls: number;
  errors: number;
  avgLatency: number;
  status: 'connected' | 'disconnected' | 'error';
}

export interface ServerCapabilities {
  tools?: Record<string, unknown>;
  resources?: { subscribe?: boolean; list?: unknown };
  prompts?: Record<string, unknown>;
  sampling?: Record<string, unknown>;
  roots?: { listChanged?: boolean };
}

// ─── Metrics Types ─────────────────────────────────────────────────────────

export interface MetricsSummary {
  totalCalls: number;
  totalErrors: number;
  errorRate: number;
  avgLatency: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  callsPerMinute: number;
  activeServers: number;
  topTools: ToolStat[];
  periodStart: string;
  periodEnd: string;
}

export interface ToolStat {
  tool: string;
  serverId: string;
  calls: number;
  errors: number;
  avgLatency: number;
  errorRate: number;
}

export interface TimeSeriesPoint {
  timestamp: string;
  calls: number;
  errors: number;
  latencyAvg: number;
  latencyP99: number;
}

// ─── Alert Types ────────────────────────────────────────────────────────────

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertAction = 'log' | 'webhook' | 'csv' | 'email';
export type AlertMetric = 'error_rate' | 'latency_p50' | 'latency_p95' | 'latency_p99' | 'calls_per_min';

export interface AlertConfig {
  id: string;
  name: string;
  metric: AlertMetric;
  threshold: number;
  window: string; // e.g. "5m", "1h"
  severity: AlertSeverity;
  actions: AlertAction[];
  enabled: boolean;
  cooldown: number; // seconds
}

export interface Alert {
  id: string;
  alertId: string;
  name: string;
  metric: AlertMetric;
  value: number;
  threshold: number;
  window: string;
  severity: AlertSeverity;
  serverId?: string;
  message: string;
  firedAt: string;
  resolvedAt?: string;
}

// ─── WebSocket Event Types ──────────────────────────────────────────────────

export type WSEventType =
  | 'call:start'
  | 'call:end'
  | 'call:error'
  | 'metrics:update'
  | 'alert:trigger'
  | 'server:connect'
  | 'server:disconnect'
  | 'heartbeat';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  payload: T;
  seq: number;
  timestamp: string;
}

export interface CallStartPayload { id: string; serverId: string; tool: string; timestamp: string; }
export interface CallEndPayload extends MCPCall {}
export interface CallErrorPayload { id: string; serverId: string; error: string; timestamp: string; }
export interface MetricsUpdatePayload { metrics: MetricsSummary; }
export interface AlertTriggerPayload { alert: Alert; }
export interface ServerConnectPayload { server: MCPServer; }
export interface ServerDisconnectPayload { serverId: string; }

// ─── API Types ─────────────────────────────────────────────────────────────

export interface APIResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
    hasMore?: boolean;
  };
}

// ─── Config Types ───────────────────────────────────────────────────────────

export interface PulseConfig {
  dashboard: DashboardConfig;
  proxy: ProxyConfig;
  alerts: AlertConfig[];
  export: ExportConfig;
}

export interface DashboardConfig {
  port: number;
  host: string;
  auth?: { enabled: boolean; token?: string };
  retention: { hours: number; maxCalls: number };
}

export interface ProxyConfig {
  port: number;
  target: string;
  protocol: 'sse' | 'stdio' | 'stream';
  sampling: number;
}

export interface ExportConfig {
  defaultFormat: 'csv' | 'json';
  includePayloads: boolean;
}

// ─── Store Types ────────────────────────────────────────────────────────────

export interface StoreState {
  calls: Map<string, MCPCall>;
  servers: Map<string, MCPServer>;
  alerts: Alert[];
  metrics: MetricsSummary;
  timeseries: TimeSeriesPoint[];
}
