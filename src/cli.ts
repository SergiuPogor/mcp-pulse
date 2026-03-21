#!/usr/bin/env node
/**
 * mcp-pulse CLI entry point
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { PulseStore } from './store.js'
import { Dashboard } from './dashboard.js'
import { ProxyServer } from './proxy.js'
import type { AlertConfig, PulseConfig } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))

const program = new Command()

// ─── Banner ──────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('')
  console.log(chalk.blue('  ┌─────────────────────────────────────────┐'))
  console.log(
    chalk.blue('  │') +
      chalk.bold.white('  🔴 mcp-pulse') +
      chalk.dim(' — MCP Observability    ') +
      chalk.blue('│'),
  )
  console.log(
    chalk.blue('  │') +
      chalk.dim(`  v${pkg.version}  ·  MIT License               `) +
      chalk.blue('│'),
  )
  console.log(chalk.blue('  └─────────────────────────────────────────┘'))
  console.log('')
}

// ─── Default Alert Configs ────────────────────────────────────────────────────
const DEFAULT_ALERT_CONFIGS: AlertConfig[] = [
  {
    id: 'alert-error-rate',
    name: 'High Error Rate',
    metric: 'error_rate',
    threshold: 10,
    window: '5m',
    severity: 'critical',
    actions: ['log', 'webhook'],
    enabled: true,
    cooldown: 300,
  },
  {
    id: 'alert-latency-p99',
    name: 'High P99 Latency',
    metric: 'latency_p99',
    threshold: 2000,
    window: '5m',
    severity: 'warning',
    actions: ['log'],
    enabled: true,
    cooldown: 300,
  },
]

// ─── Load Config ──────────────────────────────────────────────────────────────
function loadConfig(): PulseConfig {
  const defaults: PulseConfig = {
    dashboard: {
      port: parseInt(process.env['MCP_PULSE_PORT'] ?? '3000'),
      host: '127.0.0.1',
      retention: {
        hours: parseInt(process.env['MCP_PULSE_RETENTION'] ?? '24'),
        maxCalls: 100_000,
      },
      auth: {
        enabled: Boolean(process.env['MCP_PULSE_AUTH_TOKEN']),
        token: process.env['MCP_PULSE_AUTH_TOKEN'],
      },
    },
    proxy: {
      port: parseInt(process.env['MCP_PULSE_PROXY_PORT'] ?? '3100'),
      target: process.env['MCP_PULSE_TARGET'] ?? 'http://localhost:3001',
      protocol: 'sse',
      sampling: parseFloat(process.env['MCP_PULSE_SAMPLING'] ?? '1.0'),
    },
    alerts: DEFAULT_ALERT_CONFIGS,
    export: { defaultFormat: 'csv', includePayloads: false },
  }
  return defaults
}

// ─── CLI Definition ───────────────────────────────────────────────────────────

program
  .name('mcp-pulse')
  .description('Real-time monitoring & observability dashboard for MCP servers')
  .version(pkg.version as string, '-V, --version')

// ── dashboard ─────────────────────────────────────────────────────────────────
program
  .command('dashboard')
  .alias('d')
  .description('Start the web dashboard')
  .option('-p, --port <number>', 'Dashboard port', '3000')
  .option('--host <host>', 'Bind host', '127.0.0.1')
  .option('--public', 'Bind to 0.0.0.0 (public access)')
  .option('--retention <hours>', 'Hours of data to retain', '24')
  .option('--max-calls <n>', 'Maximum calls to retain in memory', '100000')
  .action(async (opts) => {
    printBanner()
    const port = parseInt(opts.port as string)
    const host = opts.public ? '0.0.0.0' : opts.host
    const maxCalls = parseInt(opts.maxCalls as string)
    const config = loadConfig()

    const store = new PulseStore(maxCalls)
    const dashboard = new Dashboard({
      port,
      host,
      store,
      alertConfigs: config.alerts,
      authToken: process.env['MCP_PULSE_AUTH_TOKEN'],
    })

    await dashboard.start()

    console.log(chalk.green('  ✓ Dashboard started'))
    console.log(
      chalk.dim(`  → Web UI:         `) + chalk.white.underline(`http://localhost:${port}`),
    )
    console.log(chalk.dim(`  → Live feed (WS): `) + chalk.white(`ws://localhost:${port}/live`))
    console.log(chalk.dim(`  → API:            `) + chalk.white(`http://localhost:${port}/api`))
    console.log('')
    console.log(chalk.dim('  Now proxy an MCP server:'))
    console.log(chalk.cyan(`  mcp-pulse proxy --target http://localhost:3001`))
    console.log('')

    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n  Shutting down…'))
      dashboard.stop()
      process.exit(0)
    })
  })

// ── proxy ─────────────────────────────────────────────────────────────────────
program
  .command('proxy')
  .alias('p')
  .description('Proxy an SSE-based MCP server and intercept all traffic')
  .requiredOption('-t, --target <url>', 'Target MCP server URL')
  .option('-p, --port <number>', 'Proxy listen port', '3100')
  .option('--dashboard <url>', 'Dashboard URL to push events to', 'http://localhost:3000')
  .option('--sampling <rate>', 'Capture rate 0.0–1.0', '1.0')
  .option('--server-id <id>', 'Server identifier')
  .option('--server-name <name>', 'Server display name')
  .action(async (opts) => {
    printBanner()
    const config = loadConfig()

    const store = new PulseStore(config.dashboard.retention.maxCalls)
    const proxy = new ProxyServer(store, {
      targetUrl: opts.target,
      listenPort: parseInt(opts.port),
      dashboardUrl: opts.dashboard,
      samplingRate: parseFloat(opts.sampling),
      serverId: opts.serverId ?? 'proxy',
      serverName: opts.serverName ?? new URL(opts.target).hostname,
    })

    await proxy.start()

    console.log(chalk.green('  ✓ Proxy started'))
    console.log(chalk.dim(`  → Listening:  `) + chalk.white(`http://localhost:${opts.port}`))
    console.log(chalk.dim(`  → Target MCP: `) + chalk.white(opts.target))
    console.log(chalk.dim(`  → Dashboard:  `) + chalk.white(opts.dashboard))
    console.log('')
    console.log(
      chalk.dim('  Point your MCP client at: ') + chalk.cyan(`http://localhost:${opts.port}/sse`),
    )
    console.log('')

    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n  Shutting down proxy…'))
      proxy.stop()
      process.exit(0)
    })
  })

// ── alert ─────────────────────────────────────────────────────────────────────
program
  .command('alert')
  .description('Run the alert engine against a running dashboard')
  .option('--dashboard <url>', 'Dashboard URL', 'http://localhost:3000')
  .option('--threshold <pct>', 'Error rate % threshold', '10')
  .option('--webhook <url>', 'Webhook URL for alert delivery')
  .option('--interval <secs>', 'Check interval in seconds', '30')
  .action(async (opts) => {
    const threshold = parseFloat(opts.threshold)
    const interval = parseInt(opts.interval) * 1000
    const webhookUrl = opts.webhook ?? process.env['MCP_PULSE_WEBHOOK_URL']

    console.log(chalk.blue(`[mcp-pulse alert] Watching ${opts.dashboard}`))
    console.log(chalk.dim(`  Error rate threshold: ${threshold}%`))
    console.log(chalk.dim(`  Check interval: ${opts.interval}s`))
    if (webhookUrl) console.log(chalk.dim(`  Webhook: ${webhookUrl}`))
    console.log('')

    const checkAlerts = async () => {
      try {
        const res = (await fetch(`${opts.dashboard}/api/metrics`).then((r) => r.json())) as {
          ok: boolean
          data: { errorRate: number }
        }
        if (!res.ok) return
        const m = res.data
        if (m.errorRate >= threshold) {
          const msg = `[mcp-pulse] ⚠ Error rate ${m.errorRate.toFixed(1)}% exceeds threshold ${threshold}%`
          console.log(chalk.red(msg))
          if (webhookUrl) {
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: msg }),
            }).catch(() => {})
          }
        } else {
          console.log(chalk.green(`[mcp-pulse alert] OK — error rate: ${m.errorRate.toFixed(1)}%`))
        }
      } catch (err) {
        console.log(
          chalk.yellow(`[mcp-pulse alert] Cannot reach dashboard: ${(err as Error).message}`),
        )
      }
    }

    await checkAlerts()
    const handle = setInterval(checkAlerts, interval)
    process.on('SIGINT', () => {
      clearInterval(handle)
      process.exit(0)
    })
  })

// ── export ────────────────────────────────────────────────────────────────────
program
  .command('export')
  .description('Export call data from a running dashboard')
  .option('--dashboard <url>', 'Dashboard URL', 'http://localhost:3000')
  .option('--format <fmt>', 'Output format: csv|json', 'csv')
  .option('--output <path>', 'Output file path (default: stdout)')
  .option('--hours <n>', 'Export last N hours', '1')
  .action(async (opts) => {
    const url = `${opts.dashboard}/api/export?format=${opts.format}`

    try {
      const res = await fetch(url)
      const text = await res.text()

      if (opts.output) {
        const { writeFileSync } = await import('fs')
        writeFileSync(opts.output, text)
        console.log(chalk.green(`✓ Exported to ${opts.output}`))
      } else {
        process.stdout.write(text)
      }
    } catch (err) {
      console.error(chalk.red(`Export failed: ${(err as Error).message}`))
      process.exit(1)
    }
  })

program.parse(process.argv)
