# 0rrery

Trace-first, local-first observability for AI agent workflows. Watch what your Claude Code sessions actually did — every tool call, subagent, LLM call, and permission decision — as live traces in a local dashboard. One process, one SQLite file, no cloud.

## Quickstart

```
bun install -g 0rrery
0rrery init
```

`init` does three things (each skippable): installs Claude Code hooks (`--no-hooks`), sets up a user service so 0rrery runs persistently (`--no-service`), and imports your existing session history (`--no-import`). Then open **http://localhost:7317**.

Requires [Bun](https://bun.sh) ≥ 1.1. Claude Code hooks require the global install (the hook command is `0rrery hook`); `bunx 0rrery serve` works for a look around without installing.

## Commands

| Command | What it does |
|---|---|
| `0rrery init` | hooks + service + history import, idempotently |
| `0rrery serve` | run the server + dashboard in the foreground |
| `0rrery install` | (re)install Claude Code hooks into `~/.claude/settings.json`; replaces stale 0rrery entries |
| `0rrery import <file.jsonl>` | import one transcript |
| `0rrery import --all` | import everything under `~/.claude/projects` |
| `0rrery service install\|uninstall\|status` | manage the systemd user unit (Linux) / launchd agent (macOS) |

## What gets written where

- `~/.claude/settings.json` — hook entries (command `0rrery hook`)
- `~/.0rrery/` — SQLite DB + tailer offsets
- `~/.config/systemd/user/0rrery.service` or `~/Library/LaunchAgents/com.0pon.0rrery.plist`

## Configuration

| Env var | Default | |
|---|---|---|
| `ORRERY_PORT` | `7317` | dashboard/API port |
| `ORRERY_HOST` | `127.0.0.1` | bind address (localhost-only by design) |
| `ORRERY_DATA_DIR` | `~/.0rrery` | data directory |
| `ORRERY_DB` | `<data dir>/0rrery.db` | database path |
| `ORRERY_URL` | `http://localhost:7317` | where hooks/import post to |
| `ORRERY_CLAUDE_DIR` | `~/.claude` | Claude Code config/transcripts root |

## Upgrade

```
bun install -g 0rrery@latest
0rrery service uninstall && 0rrery service install   # regenerate if the bin path changed
```

After upgrading (or when developing from the repo), rebuild and force a reinstall so the dashboard picks up the new bundle: `bun run build:pkg`, then `bun install -g 0rrery@latest` for registry installs, or `cd ~ && bun install --force` for `file:`-pinned dev installs — an unchanged `file:` dep may skip re-copying otherwise.

## Uninstall

```
0rrery service uninstall
bun remove -g 0rrery
rm -rf ~/.0rrery
```
Hook entries: re-run a Claude session or remove entries whose command is `0rrery hook` from `~/.claude/settings.json`.

## Development

```
bun install
bun run build        # dashboard
bun test
bun packages/cli/src/index.ts serve
bun run build:pkg    # stage the npm package in dist-pkg/
```

Specs live in `docs/superpowers/specs/`.
