# 🔴 mcp-pulse

> **Real-time monitoring & observability dashboard for Model Context Protocol (MCP) servers.**
> Gain complete visibility into your AI workflows — track tool calls, latency, errors, and usage patterns in a beautiful live dashboard.

[![npm version](https://img.shields.io/npm/v/mcp-pulse.svg)](https://www.npmjs.com/package/mcp-pulse)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

---

<div align="center">

![mcp-pulse](https://raw.githubusercontent.com/SergiuPogor/mcp-pulse/main/docs/mcp-pulse.gif)

*Live dashboard with real-time metrics, call traces, and alerting*

</div>

---

## ✨ Features

### 📊 Real-Time Dashboard
- **Live call traces** — watch every MCP tool call as it happens
- **Latency tracking** — per-call, per-server, and rolling average histograms
- **Error rate monitoring** — surface failing tools with stack traces
- **Request volume** — calls/minute with configurable time windows

### 🔍 Deep Observability
- **Structured logging** — every request/response with full JSON payload inspection
- **Tool usage leaderboard** — know which tools your AI calls most
- **Session replay** — replay any captured session from start to finish
- **Filter & search** — by server, tool name, status, latency, or time range

### 🚨 Smart Alerting
- **Threshold alerts** — notify when error rate or latency exceeds limits
- **Anomaly detection** — flag unusual patterns automatically
- **Webhook + log + CSV** — flexible alert delivery

### 🧩 MCP Ecosystem Integration
- **Works with any SSE transport** — all official MCP servers (Filesystem, GitHub, Slack, etc.)
- **Zero-code integration** — pass `--mcp-pulse` flag to any compatible server
- **Protocol-aware** — understands `initialize`, `tools/list`, `tools/call`, `sampling/create`, `roots/list`

### 💻 Developer Experience
- **WebSocket + HTTP** — connect dashboard to local or remote servers
- **Dark mode by default** — OLED-friendly dark theme
- **Export to CSV / JSON** — full raw data export for analysis
- **Health check endpoint** — `/health` for container orchestration

---

## ⚡ Quick Start

### 1 — Install

```bash
npm install -g mcp-pulse
```

### 2 — Start the Dashboard

```bash
mcp-pulse dashboard
# → Opens at http://localhost:3000
```

### 3 — Proxy Any MCP Server

In a **new terminal**, proxy any SSE-based MCP server:

```bash
# Wrap the official filesystem server
npx @modelcontextprotocol/server-filesystem ./projects \
  --mcp-pulse \
  --mcp-pulse-port 3100

# Or wrap via stdio with the pulse proxy
cat my_server_output.json | mcp-pulse proxy --protocol sse --port 3100
```

### 4 — Open Your Browser

```
http://localhost:3000
```

---

## 🐳 Docker

```bash
# Run dashboard
docker run -p 3000:3000 -p 3100:3100 \
  --env MCP_PULSE_PORT=3100 \
  SergiuPogor/mcp-pulse:latest

# Proxy an MCP server inside Docker
docker run -p 3100:3100 \
  --env MCP_PULSE_TARGET=http://your-server:3001 \
  SergiuPogor/mcp-pulse:latest proxy
```

---

## 📐 Architecture

```
┌──────────────┐      ┌──────────────┐      ┌──────────────────────┐
│  MCP Client  │──────│  MCP Server  │──────│   mcp-pulse Proxy     │
│  (Claude,    │ SSE  │  (official   │──────│  (intercepts all      │
│   Cursor,    │      │   servers)   │      │   JSON-RPC messages) │
│   etc.)      │      │              │      │                      │
└──────────────┘      └──────────────┘      └──────────┬───────────┘
                                                        │ HTTP/WS
                                                        ▼
                                              ┌──────────────────┐
                                              │  mcp-pulse       │
                                              │  Dashboard       │
                                              │  (Express + WS)  │
                                              └──────────────────┘
```

### How the Proxy Works

1. Client initiates SSE connection to MCP server
2. `mcp-pulse proxy` intercepts the JSON-RPC traffic
3. Each message is logged, timed, and forwarded in real-time
4. Dashboard receives a live stream via WebSocket
5. Metrics are aggregated in-memory with configurable retention

---

## 🛠️ CLI Reference

```bash
mcp-pulse [command]

Commands:
  dashboard          Start the web dashboard (default port 3000)
  proxy              Start a proxy server that intercepts MCP traffic
  proxy:stdio        Wrap a stdio-based MCP server ( Pipes JSON-RPC)
  alert              Run the alert engine (reads from dashboard API)
  export             Export captured data to CSV or JSON

Options:
  --port, -p         Port for dashboard or proxy        [default: 3000]
  --target, -t       Target MCP server URL (for proxy)  [required]
  --protocol         Transport: sse | stdio | stream   [default: sse]
  --retention        How many hours to keep data         [default: 24]
  --alert-threshold  Error rate % to trigger alert      [default: 10]
  --json             Output raw JSON (for scripting)
  --verbose          Enable verbose logging
  --help             Show help
```

### Examples

```bash
# Start dashboard on port 8080
mcp-pulse dashboard --port 8080

# Proxy an SSE server
mcp-pulse proxy --target http://localhost:3001 --port 3100

# Proxy a stdio server and stream its output
mcp-pulse proxy:stdio -- npx @modelcontextprotocol/server-github

# Run alerting engine
mcp-pulse alert --threshold 5 --webhook https://hooks.example.com/alert

# Export last 1 hour to CSV
mcp-pulse export --format csv --hours 1 --output ./report.csv
```

---

## 🔌 MCP Server Integration

### Official Servers (SSE Transport)

These servers work with `mcp-pulse proxy` out of the box:

| Server | Package | Status |
|--------|---------|--------|
| Filesystem | `@modelcontextprotocol/server-filesystem` | ✅ Tested |
| GitHub | `@modelcontextprotocol/server-github` | ✅ Tested |
| Slack | `@modelcontextprotocol/server-slack` | ✅ Tested |
| Google Maps | `@modelcontextprotocol/server-google-maps` | ✅ Tested |
| Sequential Thinking | `@modelcontextprotocol/server-sequential-thinking` | ✅ Tested |
| Sentry | `@modelcontextprotocol/server-sentry` | ✅ Tested |
| Brave Search | `@modelcontextprotocol/server-brave-search` | ✅ Tested |

### Stdio Servers

For stdio-based servers, use `proxy:stdio`:

```bash
mcp-pulse proxy:stdio -- python /path/to/your/mcp_server.py
```

### Custom Servers

To instrument a custom MCP server, add the pulse middleware:

```typescript
import { createPulseMiddleware } from 'mcp-pulse/middleware';

// In your MCP server setup:
server.addMiddleware(createPulseMiddleware({
  endpoint: 'http://localhost:3000/pulse',
  quiet: false,          // suppress pulse logging
  samplingRate: 1.0,     // capture 100% of calls (0.0–1.0)
  excludeTools: ['internal/debug'], // tools to skip
}));
```

---

## 📡 Dashboard API

The dashboard exposes a REST + WebSocket API.

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/metrics` | Aggregated metrics summary |
| `GET` | `/api/metrics/timeseries` | Time-series data for charts |
| `GET` | `/api/calls` | Paginated call log |
| `GET` | `/api/calls/:id` | Single call detail |
| `GET` | `/api/servers` | Server list with stats |
| `GET` | `/api/tools` | Tool leaderboard |
| `GET` | `/api/alerts` | Alert history |
| `POST` | `/api/alerts/config` | Update alert config |
| `GET` | `/api/export` | Download export ( ?format=csv\|json) |

### WebSocket Events

```javascript
// Connect to live stream
const ws = new WebSocket('ws://localhost:3000/live');

ws.on('message', (data) => {
  const event = JSON.parse(data);
  
  switch (event.type) {
    case 'call:start':    // MCP call initiated
    case 'call:end':      // MCP call completed (includes latency + status)
    case 'call:error':    // MCP call failed
    case 'metrics:update': // Aggregated metrics (every 5s)
    case 'alert:trigger':  // Alert fired
    case 'heartbeat':     // Connection keepalive
  }
});
```

### Event Payloads

```typescript
// call:end payload
{
  id: 'call_abc123',
  serverId: 'server_filesystem',
  tool: 'filesystem.read_file',
  duration: 42,          // ms
  status: 'success',    // 'success' | 'error' | 'timeout'
  request: {            // Sanitized request (secrets removed)
    method: 'tools/call',
    params: { name: 'read_file', arguments: { path: '/projects/README.md' } }
  },
  response: {
    content: [{ type: 'text', text: '...' }]
  },
  timestamp: '2026-03-21T14:30:00.000Z'
}

// alert:trigger payload
{
  id: 'alert_001',
  serverId: 'server_filesystem',
  metric: 'error_rate',
  value: 15.3,          // percentage
  threshold: 10.0,
  window: '5m',
  firedAt: '2026-03-21T14:30:00.000Z'
}
```

---

## ⚙️ Configuration

### Environment Variables

```bash
MCP_PULSE_PORT=3000          # Dashboard port
MCP_PULSE_PROXY_PORT=3100   # Proxy port
MCP_PULSE_RETENTION=24       # Hours of data to keep
MCP_PULSE_TARGET=            # Target MCP server URL (for proxy mode)
MCP_PULSE_SAMPLING=1.0       # Capture rate (0.0–1.0)
MCP_PULSE_AUTH_TOKEN=        # Optional: require token for API
MCP_PULSE_WEBHOOK_URL=       # Alert webhook URL
```

### config.json

Place in project root or `~/.mcp-pulse/config.json`:

```json
{
  "dashboard": {
    "port": 3000,
    "auth": {
      "enabled": false,
      "token": "your-secret-token"
    },
    "retention": {
      "hours": 24,
      "maxCalls": 100000
    }
  },
  "proxy": {
    "port": 3100,
    "target": "http://localhost:3001",
    "protocol": "sse",
    "sampling": 1.0
  },
  "alerts": [
    {
      "name": "High Error Rate",
      "metric": "error_rate",
      "threshold": 10,
      "window": "5m",
      "severity": "critical",
      "actions": ["log", "webhook"]
    },
    {
      "name": "High Latency",
      "metric": "latency_p99",
      "threshold": 2000,
      "window": "5m",
      "severity": "warning",
      "actions": ["log"]
    }
  ],
  "export": {
    "defaultFormat": "csv",
    "includePayloads": false
  }
}
```

---

## 🧪 Examples

### Example 1 — Monitor a Filesystem MCP Server

```bash
# Terminal 1: Start dashboard
mcp-pulse dashboard

# Terminal 2: Start filesystem MCP server via proxy
npx @modelcontextprotocol/server-filesystem $HOME/projects \
  --mcp-pulse \
  --mcp-pulse-port 3100 \
  --mcp-pulse-target http://localhost:3100

# Terminal 3: Use the server (e.g. in Claude Desktop)
claude

# Open http://localhost:3000 to watch all file operations
```

### Example 2 — Alert on GitHub Server Failures

```bash
# Set webhook (e.g. Discord or Slack incoming webhook)
export MCP_PULSE_WEBHOOK_URL=https://discord.com/api/webhooks/xxx/yyy

# Start alert engine
mcp-pulse alert --threshold 5 --webhook $MCP_PULSE_WEBHOOK_URL

# Start GitHub MCP server
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx
npx @modelcontextprotocol/server-github \
  --mcp-pulse \
  --mcp-pulse-port 3100
```

### Example 3 — Custom Dashboard Embed

```javascript
// Embed real-time mcp-pulse data into your own app
import { MCP PulseClient } from 'mcp-pulse/client';

const client = new MCP PulseClient({
  dashboardUrl: 'http://localhost:3000',
  apiKey: 'optional-token',
});

client.on('call:end', (call) => {
  if (call.tool.includes('github') && call.status === 'error') {
    console.error(`GitHub tool failed: ${call.tool}`, call.response);
  }
});

await client.connect();
```

---

## 🔒 Security

- **No secrets in logs** — request arguments are scanned and redacted before storage
- **Payload truncation** — large responses are truncated (configurable, default 10KB)
- **Local-only by default** — dashboard binds to `127.0.0.1` unless `--public` flag is used
- **Optional authentication** — set `MCP_PULSE_AUTH_TOKEN` to protect the API
- **GDPR note** — mcp-pulse stores data locally; no data leaves your machine unless you export it

---

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) before submitting PRs.

```bash
# Development setup
git clone https://github.com/SergiuPogor/mcp-pulse.git
cd mcp-pulse
npm install
npm run dev          # Watch mode + hot reload
npm run test         # Run tests
npm run lint         # Lint + format
```

### Reporting Issues

Please report bugs and feature requests via [GitHub Issues](https://github.com/SergiuPogor/mcp-pulse/issues). Include:
- mcp-pulse version (`mcp-pulse --version`)
- Node.js version (`node --version`)
- MCP server name and version
- Steps to reproduce

---

## 📄 License

MIT © 2026 [Sergiu Pogor](https://github.com/SergiuPogor)

---

<div align="center">

**Star it if you find it useful.**

[![Star](https://img.shields.io/github/stars/SergiuPogor/mcp-pulse?style=social)](https://github.com/SergiuPogor/mcp-pulse)

</div>
