/**
 * mcp-pulse: SSE/SSE2 Transport Proxy
 * 
 * Intercepts MCP JSON-RPC traffic between clients and servers,
 * extracts structured call data, and forwards events to the dashboard.
 */

import { createServer, Server, request as httpRequest } from 'http';
import { parse } from 'url';
import type { IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { v4 as uuid } from 'uuid';
import { PulseStore } from './store.js';
import type { MCPServer, MCPCall, SanitizedRequest, WSEvent } from './types.js';

export interface ProxyOptions {
  targetUrl: string;
  listenPort: number;
  dashboardUrl: string;
  samplingRate?: number; // 0.0–1.0
  protocol?: 'sse' | 'stdio';
  serverId?: string;
  serverName?: string;
}

interface PendingCall {
  id: string;
  serverId: string;
  tool: string;
  startTime: number;
  request: SanitizedRequest;
}

export class ProxyServer {
  private server!: Server;
  private wss!: WebSocketServer;
  private dashboardWs: WebSocket | null = null;
  private pendingCalls = new Map<string, PendingCall>();
  private connectedClients = new Set<WebSocket>();
  private mcpServerConn: { req: IncomingMessage; res: ServerResponse } | null = null;

  constructor(
    private store: PulseStore,
    private opts: ProxyOptions,
  ) {}

  async start(): Promise<{ port: number }> {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    
    return new Promise((resolve) => {
      this.server.listen(this.opts.listenPort, () => {
        const { port } = this.server.address() as AddressInfo;
        this.startDashboardBridge();
        console.log(`[mcp-pulse proxy] Listening on port ${port}`);
        console.log(`[mcp-pulse proxy] Forwarding to ${this.opts.targetUrl}`);
        resolve({ port });
      });
    });
  }

  stop(): void {
    this.dashboardWs?.close();
    this.wss.close();
    this.server.close();
  }

  // ─── HTTP/SSE Proxy ────────────────────────────────────────────────────

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const { pathname } = parse(req.url ?? '/');

    // MCP server-sent events endpoint
    if (pathname === '/sse' || pathname === '/mcp') {
      this.handleSSEClient(req, res);
      return;
    }

    // MCP client → upstream server
    if (pathname === '/message') {
      this.handleClientMessage(req, res);
      return;
    }

    // Health
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  private async handleSSEClient(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Track connected MCP clients (browsers, Claude, etc.)
    const clientWs = this.upgradeToWebSocket(req, res);
    if (!clientWs) {
      // Not a WebSocket upgrade — treat as SSE
      this.setupSSEClient(req, res);
      return;
    }

    this.connectedClients.add(clientWs);
    clientWs.on('close', () => this.connectedClients.delete(clientWs));
    clientWs.on('message', (data) => this.onClientMessage(data.toString()));

    // Establish upstream MCP server connection
    await this.connectToUpstream();

    // Send initial connection event
    const connectEvent = this.store.makeEvent('server:connect', {
      server: this.getOrCreateServer(),
    });
    clientWs.send(`data: ${JSON.stringify(connectEvent)}\n\n`);
  }

  private setupSSEClient(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Register as connected client
    const clientId = uuid();
    (req as IncomingMessage & { clientId: string }).clientId = clientId;

    const keepAlive = setInterval(() => {
      res.write(`: keepalive\n\n`);
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
    });

    this.connectToUpstream().catch(console.error);
  }

  private upgradeToWebSocket(req: IncomingMessage, res: ServerResponse): WebSocket | null {
    const key = req.headers['sec-websocket-key'];
    if (!key) return null;

    // We need the raw socket — create a basic WS server on same server
    // This is handled by the dedicated WS server
    return null; // handled separately
  }

  private async handleClientMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const json = JSON.parse(body);
        this.processJSONRPC(json);
        
        // Forward to upstream
        const upstreamRes = await this.forwardToUpstream(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(upstreamRes);
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private async connectToUpstream(): Promise<void> {
    return new Promise((resolve) => {
      const targetUrl = new URL(this.opts.targetUrl);
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname === '/' ? '/sse' : targetUrl.pathname,
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      };

      const proxyReq = httpRequest(options, (upstreamRes) => {
        this.mcpServerConn = { req: proxyReq, res: upstreamRes as unknown as ServerResponse };
        
        upstreamRes.on('data', (chunk: Buffer) => {
          const data = chunk.toString();
          // Parse SSE lines and broadcast to clients
          for (const line of data.split('\n')) {
            if (line.startsWith('data: ')) {
              const payload = line.slice(6);
              try {
                const parsed = JSON.parse(payload);
                this.handleUpstreamMessage(parsed);
                this.broadcastToClients(`data: ${payload}\n\n`);
              } catch {
                this.broadcastToClients(`data: ${payload}\n\n`);
              }
            }
          }
        });

        upstreamRes.on('end', () => {
          const discEvent = this.store.makeEvent('server:disconnect', { serverId: this.opts.serverId });
          this.broadcastToClients(`data: ${JSON.stringify(discEvent)}\n\n`);
        });

        resolve();
      });

      proxyReq.on('error', (err) => {
        console.error(`[mcp-pulse proxy] Upstream error: ${err.message}`);
      });

      proxyReq.end();
    });
  }

  private onClientMessage(data: string): void {
    try {
      const json = JSON.parse(data);
      this.processJSONRPC(json);

      // Forward to upstream MCP server
      if (this.mcpServerConn) {
        // Forward raw to upstream
        const targetUrl = new URL(this.opts.targetUrl);
        const options = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: '/message',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        };
        const fwdReq = httpRequest(options, (fwdRes) => {
          let fwdBody = '';
          fwdRes.on('data', (c) => (fwdBody += c));
          fwdRes.on('end', () => {
            // Broadcast response back to client
            try {
              const fwdJson = JSON.parse(fwdBody);
              this.handleUpstreamMessage(fwdJson);
              for (const client of this.connectedClients) {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify(fwdJson));
                }
              }
            } catch { /* ignore */ }
          });
        });
        fwdReq.write(data);
        fwdReq.end();
      }
    } catch { /* ignore */ }
  }

  private handleUpstreamMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, unknown>;

    // Track responses to pending calls
    if (msg.id !== undefined) {
      const callId = String(msg.id);
      const pending = this.pendingCalls.get(callId);
      if (pending) {
        this.completeCall(callId, msg.result ?? msg.error);
        this.pendingCalls.delete(callId);
      }
    }
  }

  private processJSONRPC(json: Record<string, unknown>): void {
    const method = (json.method as string) ?? '';
    const callId = String(json.id ?? uuid());

    // Only instrument tool calls and resource operations
    const trackedMethods = ['tools/call', 'tools/list', 'resources/read', 'prompts/get', 'sampling/create'];
    if (!trackedMethods.includes(method)) return;

    // Sampling check
    if (Math.random() > (this.opts.samplingRate ?? 1.0)) return;

    const toolName = method === 'tools/call'
      ? ((json.params as Record<string, unknown>)?.name as string) ?? method
      : method;

    const pending: PendingCall = {
      id: callId,
      serverId: this.opts.serverId ?? 'proxy',
      tool: toolName,
      startTime: Date.now(),
      request: {
        method: method as SanitizedRequest['method'],
        params: json.params as Record<string, unknown>,
      },
    };
    this.pendingCalls.set(callId, pending);

    // Emit call:start
    const startEvent = this.store.makeEvent('call:start', {
      id: callId,
      serverId: pending.serverId,
      tool: toolName,
      timestamp: new Date().toISOString(),
    });
    this.sendToDashboard(startEvent);
  }

  private completeCall(callId: string, result: unknown): void {
    const pending = this.pendingCalls.get(callId);
    if (!pending) return;

    const duration = Date.now() - pending.startTime;
    const hasError = !result || (typeof result === 'object' && (result as Record<string, unknown>).isError);

    const call: MCPCall = {
      id: callId,
      serverId: pending.serverId,
      serverName: this.opts.serverName ?? 'MCP Server',
      tool: pending.tool,
      method: pending.request.method,
      status: hasError ? 'error' : 'success',
      duration,
      request: pending.request,
      response: result ? { content: Array.isArray(result) ? result as unknown[] : [result] } : undefined,
      errorMessage: hasError && typeof result === 'object'
        ? (result as Record<string, unknown>)?.message as string
        : undefined,
      timestamp: new Date().toISOString(),
      size: JSON.stringify(result).length,
    };

    this.store.addCall(call);
    this.store.updateServerActivity(pending.serverId);

    const eventType = hasError ? 'call:error' : 'call:end';
    const event = this.store.makeEvent(eventType, call);
    this.sendToDashboard(event);
  }

  private sendToDashboard(event: WSEvent): void {
    if (this.dashboardWs?.readyState === WebSocket.OPEN) {
      this.dashboardWs.send(JSON.stringify(event));
    }
  }

  private broadcastToClients(data: string): void {
    for (const client of this.connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  private async forwardToUpstream(body: string): Promise<string> {
    return new Promise((resolve) => {
      try {
        const targetUrl = new URL(this.opts.targetUrl);
        const options = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: '/message',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        };
        const proxyReq = httpRequest(options, (proxyRes) => {
          let respBody = '';
          proxyRes.on('data', (c) => (respBody += c));
          proxyRes.on('end', () => resolve(respBody || '{}'));
        });
        proxyReq.on('error', () => resolve('{}'));
        proxyReq.write(body);
        proxyReq.end();
      } catch {
        resolve('{}');
      }
    });
  }

  private getOrCreateServer(): MCPServer {
    const existing = this.store.getServer(this.opts.serverId ?? 'proxy');
    if (existing) return existing;

    const server: MCPServer = {
      id: this.opts.serverId ?? 'proxy',
      name: this.opts.serverName ?? 'MCP Server',
      version: '1.0.0',
      protocolVersion: '2024-11-05',
      capabilities: {},
      connectedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      calls: 0,
      errors: 0,
      avgLatency: 0,
      status: 'connected',
    };
    this.store.upsertServer(server);
    return server;
  }

  private startDashboardBridge(): void {
    const dashboardUrl = new URL(this.opts.dashboardUrl);
    const wsUrl = `${dashboardUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${dashboardUrl.host}/live`;

    const connect = () => {
      this.dashboardWs = new WebSocket(wsUrl);
      
      this.dashboardWs.on('open', () => {
        console.log(`[mcp-pulse proxy] Connected to dashboard at ${wsUrl}`);
        // Announce server
        const event = this.store.makeEvent('server:connect', { server: this.getOrCreateServer() });
        this.dashboardWs!.send(JSON.stringify(event));
      });

      this.dashboardWs.on('close', () => {
        setTimeout(connect, 3000);
      });

      this.dashboardWs.on('error', () => {
        this.dashboardWs?.close();
      });
    };

    connect();
  }
}
