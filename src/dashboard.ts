/**
 * mcp-pulse: Dashboard HTTP + WebSocket Server
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { AddressInfo } from 'net';
import { PulseStore } from './store.js';
import type { AlertConfig, WSEvent } from './types.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

// ─── Dashboard Server ──────────────────────────────────────────────────────

export interface DashboardOptions {
  port: number;
  host: string;
  store: PulseStore;
  alertConfigs: AlertConfig[];
  authToken?: string;
}

export class Dashboard {
  private app!: express.Application;
  private server!: Server;
  private wss!: WebSocketServer;
  private clients = new Set<WebSocket>();
  private store: PulseStore;
  private alertConfigs: AlertConfig[];
  private authToken?: string;
  private metricsInterval?: NodeJS.Timeout;
  private alertInterval?: NodeJS.Timeout;

  constructor(private opts: DashboardOptions) {
    this.store = opts.store;
    this.alertConfigs = opts.alertConfigs;
    this.authToken = opts.authToken;
  }

  async start(): Promise<{ port: number }> {
    this.app = express();
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), '../client')));

    // Optional auth middleware
    if (this.authToken) {
      this.app.use((req, res, next) => {
        const token = req.headers['x-api-token'] as string ?? req.query['token'] as string;
        if (token !== this.authToken) {
          res.status(401).json({ ok: false, error: 'Unauthorized' });
          return;
        }
        next();
      });
    }

    this.setupRoutes();

    this.server = createServer(this.app);

    // WebSocket endpoint
    this.wss = new WebSocketServer({ server: this.server, path: '/live' });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      // Send heartbeat
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(this.store.makeEvent('heartbeat', {})));
        }
      }, 15000);
      ws.on('close', () => clearInterval(heartbeat));
    });

    return new Promise((resolve) => {
      this.server.listen(this.opts.port, this.opts.host, () => {
        const { port } = this.server.address() as AddressInfo;
        console.log(`[mcp-pulse dashboard] http://localhost:${port}`);
        this.startBackgroundJobs();
        resolve({ port });
      });
    });
  }

  stop(): void {
    clearInterval(this.metricsInterval);
    clearInterval(this.alertInterval);
    this.wss.close();
    this.server.close();
  }

  // ─── Routes ─────────────────────────────────────────────────────────────

  private setupRoutes(): void {
    // API v1 prefix
    const api = '/api';

    this.app.get(`${api}/health`, (_req, res) => {
      res.json({ ok: true, uptime: process.uptime(), version: '1.0.0' });
    });

    this.app.get(`${api}/metrics`, (_req, res) => {
      const metrics = this.store.getMetrics();
      res.json({ ok: true, data: metrics });
    });

    this.app.get(`${api}/metrics/timeseries`, (req, res) => {
      const window = Math.min(parseInt(req.query['window'] as string ?? '60'), 1440);
      const ts = this.store.getTimeseries(window);
      res.json({ ok: true, data: ts });
    });

    this.app.get(`${api}/calls`, (req, res) => {
      const calls = this.store.getCalls({
        serverId: req.query['serverId'] as string | undefined,
        tool: req.query['tool'] as string | undefined,
        status: req.query['status'] as any,
        limit: Math.min(parseInt(req.query['limit'] as string ?? '100'), 1000),
        offset: parseInt(req.query['offset'] as string ?? '0'),
        from: req.query['from'] as string | undefined,
        to: req.query['to'] as string | undefined,
      });
      const total = this.store.getCallsCount({
        serverId: req.query['serverId'] as string | undefined,
      });
      res.json({ ok: true, data: calls, meta: { total, hasMore: calls.length === 100 } });
    });

    this.app.get(`${api}/calls/:id`, (req, res) => {
      const call = this.store.getCall(req.params['id']!);
      if (!call) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
      res.json({ ok: true, data: call });
    });

    this.app.get(`${api}/servers`, (_req, res) => {
      res.json({ ok: true, data: this.store.getServers() });
    });

    this.app.get(`${api}/tools`, (_req, res) => {
      const metrics = this.store.getMetrics();
      res.json({ ok: true, data: metrics.topTools });
    });

    this.app.get(`${api}/alerts`, (req, res) => {
      const limit = parseInt(req.query['limit'] as string ?? '50');
      res.json({ ok: true, data: this.store.getAlerts(limit) });
    });

    this.app.post(`${api}/alerts/config`, (req, res) => {
      const config = req.body as AlertConfig[];
      this.alertConfigs.length = 0;
      this.alertConfigs.push(...config);
      res.json({ ok: true });
    });

    this.app.get(`${api}/export`, (req, res) => {
      const format = (req.query['format'] as string ?? 'csv') as 'csv' | 'json';
      const calls = this.store.getCalls({ limit: 100000 });
      if (format === 'json') {
        res.json({ ok: true, data: calls });
      } else {
        const header = 'id,serverId,tool,method,status,duration,timestamp\n';
        const rows = calls.map(c =>
          `${c.id},${c.serverId},${c.tool},${c.method},${c.status},${c.duration},${c.timestamp}`
        ).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="mcp-pulse-export.csv"');
        res.send(header + rows);
      }
    });

    // MCP proxy endpoint (SSE bridge)
    this.app.get('/sse', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const keepAlive = setInterval(() => res.write(`: ping\n\n`), 15000);
      req.on('close', () => clearInterval(keepAlive));
    });

    this.app.post('/message', express.json(), (req, res) => {
      // Broadcast to all WS clients
      const msg = req.body;
      this.broadcast(msg);
      res.json({ ok: true });
    });

    // SPA fallback
    this.app.get('*', (_req, res) => {
      const indexPath = join(dirname(fileURLToPath(import.meta.url)), '../client/index.html');
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(200).send(this.getEmbeddedIndexHTML());
      }
    });
  }

  // ─── Background Jobs ───────────────────────────────────────────────────

  private startBackgroundJobs(): void {
    // Push metrics updates every 5s
    this.metricsInterval = setInterval(() => {
      const metrics = this.store.getMetrics();
      const event = this.store.makeEvent('metrics:update', { metrics });
      this.broadcast(event);
    }, 5000);

    // Evaluate alerts every 30s
    this.alertInterval = setInterval(() => {
      const fired = this.store.evaluateAlerts(this.alertConfigs);
      for (const alert of fired) {
        const event = this.store.makeEvent('alert:trigger', { alert });
        this.broadcast(event);
        this.handleAlertActions(alert);
      }
    }, 30000);
  }

  private handleAlertActions(alert: ReturnType<typeof this.store.evaluateAlerts>[0]): void {
    const config = this.alertConfigs.find(c => c.id === alert.alertId);
    if (!config) return;

    for (const action of config.actions) {
      if (action === 'log') {
        const color = alert.severity === 'critical' ? '\x1b[31m' : alert.severity === 'warning' ? '\x1b[33m' : '\x1b[36m';
        console.log(`${color}[mcp-pulse alert]${'\x1b[0m'} ${alert.message}`);
      }
      if (action === 'webhook') {
        const webhookUrl = process.env['MCP_PULSE_WEBHOOK_URL'];
        if (webhookUrl) {
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: `[mcp-pulse] ${alert.message}` }),
          }).catch(() => {});
        }
      }
    }
  }

  // ─── Broadcast ─────────────────────────────────────────────────────────

  broadcast(event: WSEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // ─── Embedded HTML (fallback when client/ dir not built) ───────────────

  private getEmbeddedIndexHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>mcp-pulse — Loading</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e2e8f0;font-family:'Inter',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.loader{text-align:center}
.spinner{width:48px;height:48px;border:3px solid #1e293b;border-top-color:#3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:1.5rem;font-weight:600;margin-bottom:.5rem}
p{color:#64748b;font-size:.875rem}
</style>
</head>
<body>
<div class="loader">
<div class="spinner"></div>
<h1>mcp-pulse</h1>
<p>Building dashboard...</p>
</div>
</body>
</html>`;
  }
}
