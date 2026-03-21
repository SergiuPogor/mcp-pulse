import { describe, it, expect, beforeEach } from 'vitest'
import { PulseStore } from '../store.js'
import type { MCPCall, MCPServer } from '../types.js'

const makeCall = (overrides: Partial<MCPCall> = {}): MCPCall => ({
  id: 'call-001',
  serverId: 'srv-001',
  serverName: 'Test Server',
  tool: 'filesystem.read_file',
  method: 'tools/call',
  status: 'success',
  duration: 42,
  request: { method: 'tools/call', params: { name: 'read_file', arguments: { path: '/tmp/test' } } },
  timestamp: new Date().toISOString(),
  size: 128,
  ...overrides,
})

const makeServer = (overrides: Partial<MCPServer> = {}): MCPServer => ({
  id: 'srv-001',
  name: 'Test Server',
  version: '1.0.0',
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  connectedAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
  calls: 0,
  errors: 0,
  avgLatency: 0,
  status: 'connected',
  ...overrides,
})

describe('PulseStore', () => {
  let store: PulseStore

  beforeEach(() => {
    store = new PulseStore(1000)
  })

  // ── Servers ────────────────────────────────────────────────────────────────

  describe('servers', () => {
    it('adds and retrieves a server', () => {
      const server = makeServer()
      store.upsertServer(server)
      expect(store.getServer('srv-001')).toEqual(server)
    })

    it('returns undefined for unknown server', () => {
      expect(store.getServer('unknown')).toBeUndefined()
    })

    it('lists all servers', () => {
      store.upsertServer(makeServer({ id: 'a' }))
      store.upsertServer(makeServer({ id: 'b' }))
      expect(store.getServers()).toHaveLength(2)
    })

    it('updates server activity timestamp', () => {
      store.upsertServer(makeServer())
      const before = store.getServer('srv-001')!.lastActivityAt
      store.updateServerActivity('srv-001')
      const after = store.getServer('srv-001')!.lastActivityAt
      expect(after >= before).toBe(true)
    })
  })

  // ── Calls ──────────────────────────────────────────────────────────────────

  describe('calls', () => {
    it('adds and retrieves a call', () => {
      store.upsertServer(makeServer())
      const call = makeCall()
      store.addCall(call)
      const retrieved = store.getCall('call-001')
      expect(retrieved).toBeDefined()
      expect(retrieved!.id).toBe('call-001')
      expect(retrieved!.tool).toBe('filesystem.read_file')
    })

    it('redacts sensitive keys in params', () => {
      store.upsertServer(makeServer())
      const call = makeCall({
        request: {
          method: 'tools/call',
          params: { api_key: 'super-secret', name: 'my-tool' },
        },
      })
      store.addCall(call)
      const retrieved = store.getCall('call-001')!
      expect(retrieved.request.params!['api_key']).toBe('[REDACTED]')
      expect(retrieved.request.params!['name']).toBe('my-tool')
    })

    it('filters calls by status', () => {
      store.upsertServer(makeServer())
      store.addCall(makeCall({ id: 'c1', status: 'success' }))
      store.addCall(makeCall({ id: 'c2', status: 'error' }))
      const errors = store.getCalls({ status: 'error' })
      expect(errors).toHaveLength(1)
      expect(errors[0]!.id).toBe('c2')
    })

    it('filters calls by serverId', () => {
      store.upsertServer(makeServer({ id: 'srv-a' }))
      store.upsertServer(makeServer({ id: 'srv-b' }))
      store.addCall(makeCall({ id: 'c1', serverId: 'srv-a' }))
      store.addCall(makeCall({ id: 'c2', serverId: 'srv-b' }))
      const calls = store.getCalls({ serverId: 'srv-a' })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.serverId).toBe('srv-a')
    })

    it('respects limit and offset', () => {
      store.upsertServer(makeServer())
      for (let i = 0; i < 20; i++) {
        store.addCall(makeCall({ id: `call-${i}` }))
      }
      const page = store.getCalls({ limit: 5, offset: 5 })
      expect(page).toHaveLength(5)
    })

    it('returns total count', () => {
      store.upsertServer(makeServer())
      for (let i = 0; i < 10; i++) store.addCall(makeCall({ id: `c${i}` }))
      expect(store.getCallsCount()).toBe(10)
    })

    it('increments server call counter', () => {
      store.upsertServer(makeServer())
      store.addCall(makeCall())
      const server = store.getServer('srv-001')!
      expect(server.calls).toBe(1)
    })

    it('increments server error counter on failed call', () => {
      store.upsertServer(makeServer())
      store.addCall(makeCall({ status: 'error' }))
      const server = store.getServer('srv-001')!
      expect(server.errors).toBe(1)
    })
  })

  // ── Metrics ────────────────────────────────────────────────────────────────

  describe('metrics', () => {
    it('returns zero metrics on empty store', () => {
      const m = store.getMetrics()
      expect(m.totalCalls).toBe(0)
      expect(m.errorRate).toBe(0)
      expect(m.avgLatency).toBe(0)
    })

    it('calculates error rate correctly', () => {
      store.upsertServer(makeServer())
      store.addCall(makeCall({ id: 'c1', status: 'success' }))
      store.addCall(makeCall({ id: 'c2', status: 'error' }))
      store.addCall(makeCall({ id: 'c3', status: 'error' }))
      const m = store.getMetrics()
      expect(m.totalCalls).toBe(3)
      expect(m.totalErrors).toBe(2)
      expect(m.errorRate).toBeCloseTo(66.67, 1)
    })

    it('calculates average latency', () => {
      store.upsertServer(makeServer())
      store.addCall(makeCall({ id: 'c1', duration: 100 }))
      store.addCall(makeCall({ id: 'c2', duration: 200 }))
      store.addCall(makeCall({ id: 'c3', duration: 300 }))
      const m = store.getMetrics()
      expect(m.avgLatency).toBe(200)
    })

    it('tracks active servers count', () => {
      store.upsertServer(makeServer({ id: 'a', status: 'connected' }))
      store.upsertServer(makeServer({ id: 'b', status: 'connected' }))
      const m = store.getMetrics()
      expect(m.activeServers).toBe(2)
    })

    it('returns top tools sorted by call count', () => {
      store.upsertServer(makeServer())
      for (let i = 0; i < 5; i++) store.addCall(makeCall({ id: `c${i}`, tool: 'read_file' }))
      for (let i = 5; i < 7; i++) store.addCall(makeCall({ id: `c${i}`, tool: 'write_file' }))
      const m = store.getMetrics()
      expect(m.topTools[0]!.tool).toBe('read_file')
      expect(m.topTools[0]!.calls).toBe(5)
    })
  })

  // ── Timeseries ─────────────────────────────────────────────────────────────

  describe('timeseries', () => {
    it('returns correct number of time buckets', () => {
      const ts = store.getTimeseries(60)
      expect(ts.length).toBe(60)
    })

    it('includes recent calls in correct bucket', () => {
      store.upsertServer(makeServer())
      store.addCall(makeCall({ id: 'c1', timestamp: new Date().toISOString() }))
      const ts = store.getTimeseries(60)
      const total = ts.reduce((sum, p) => sum + p.calls, 0)
      expect(total).toBe(1)
    })
  })

  // ── Alerts ─────────────────────────────────────────────────────────────────

  describe('alerts', () => {
    it('fires alert when error rate exceeds threshold', () => {
      store.upsertServer(makeServer())
      for (let i = 0; i < 5; i++) store.addCall(makeCall({ id: `c${i}`, status: 'error' }))
      const fired = store.evaluateAlerts([{
        id: 'a1',
        name: 'High Errors',
        metric: 'error_rate',
        threshold: 50,
        window: '5m',
        severity: 'critical',
        actions: ['log'],
        enabled: true,
        cooldown: 0,
      }])
      expect(fired).toHaveLength(1)
      expect(fired[0]!.metric).toBe('error_rate')
    })

    it('does not fire when below threshold', () => {
      store.upsertServer(makeServer())
      store.addCall(makeCall({ id: 'c1', status: 'success' }))
      const fired = store.evaluateAlerts([{
        id: 'a1',
        name: 'High Errors',
        metric: 'error_rate',
        threshold: 50,
        window: '5m',
        severity: 'critical',
        actions: ['log'],
        enabled: true,
        cooldown: 0,
      }])
      expect(fired).toHaveLength(0)
    })

    it('respects enabled flag', () => {
      store.upsertServer(makeServer())
      for (let i = 0; i < 5; i++) store.addCall(makeCall({ id: `c${i}`, status: 'error' }))
      const fired = store.evaluateAlerts([{
        id: 'a1',
        name: 'Disabled Alert',
        metric: 'error_rate',
        threshold: 10,
        window: '5m',
        severity: 'critical',
        actions: ['log'],
        enabled: false,
        cooldown: 0,
      }])
      expect(fired).toHaveLength(0)
    })
  })

  // ── WebSocket Events ───────────────────────────────────────────────────────

  describe('event helpers', () => {
    it('generates sequential seq numbers', () => {
      const e1 = store.makeEvent('heartbeat', {})
      const e2 = store.makeEvent('heartbeat', {})
      expect(e2.seq).toBe(e1.seq + 1)
    })

    it('includes ISO timestamp in events', () => {
      const e = store.makeEvent('heartbeat', {})
      expect(() => new Date(e.timestamp)).not.toThrow()
    })
  })
})
