# Contributing to mcp-pulse

We welcome contributions of all kinds — bug fixes, features, documentation improvements, and examples.

## Development Setup

```bash
git clone https://github.com/phantomfallstudios/mcp-pulse.git
cd mcp-pulse
npm install
npm run dev   # Start in watch mode
```

## Architecture Overview

```
src/
  cli.ts         ← Commander CLI entry point
  dashboard.ts   ← Express + WebSocket dashboard server
  proxy.ts       ← MCP SSE proxy (intercepts JSON-RPC)
  store.ts       ← In-memory data store + metrics engine
  types.ts       ← Shared TypeScript types
  client/
    index.html   ← Dashboard SPA
    styles/      ← CSS
    js/          ← Frontend JavaScript
```

## Coding Standards

- **TypeScript strict mode** — no `any`, no unused vars
- **No external runtime deps** beyond what's in `package.json`
- **Test your changes** — run `npm test` before submitting
- **Keep it fast** — the store is in-memory; keep operations O(n) or better

## Submitting Changes

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Make your changes with clear, focused commits
4. Run `npm test && npm run lint`
5. Open a Pull Request with a clear description

## Reporting Bugs

Include:
- mcp-pulse version (`mcp-pulse --version`)
- Node.js version
- MCP server you're monitoring
- Steps to reproduce + expected vs. actual behavior

## License

By contributing, you agree your changes will be released under the MIT License.
