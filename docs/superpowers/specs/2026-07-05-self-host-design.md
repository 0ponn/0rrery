# 0rrery Self-Host v1 Design

Date: 2026-07-05
Status: approved pending user spec review
Parent: `2026-07-04-0rrery-rebuild-design.md` (v1 platform), `docs/dogfood-findings-2026-07-05.md` (import-truthfulness prerequisite, fixed at `552d7a2`).

## Summary

0rrery becomes installable by a solo dev on their own machine: an npm package (`0rrery`, bun runtime) with a portable hook command, a service generator for systemd/launchd, and a single guided `0rrery init` that gets from zero to a dashboard full of the user's real history. Publishing to npm is a separate, approval-gated action; this unit delivers the verified artifact.

## Decisions (user-approved 2026-07-05)

- **Target:** solo dev, own machine. Localhost posture unchanged. No Docker, no auth hardening, no multi-user.
- **Distribution:** npm package named `0rrery` (verified unclaimed; fallback `@0pon/0rrery` if squatted before publish). Bun-only: `engines: { bun: ">=1.1" }`, `#!/usr/bin/env bun` shebang; no node compat.
- **Service:** `0rrery service` codegen, not docs-only and not self-daemonizing.
- **Borrowed from CaseyHaralson/orrery** (unrelated product, good packaging): single guided `init`; agent-facing skills shipped in-package noted as a future, not built now.

## Current state (probed)

- CLI (`packages/cli/src/index.ts`, 50 lines): `serve`, `install` (idempotent hook merge into `~/.claude/settings.json`, command `bun <abs repo path>/hook.ts`), `import <file>`.
- Config already portable except one path: `dataDir` defaults to `~/.0rrery`, env overrides `ORRERY_PORT/HOST/DB/TOKEN` exist; `dashboardDist` resolves `../../dashboard/dist` relative to `import.meta.dir` — repo-layout-only.
- This machine runs a hand-written systemd user unit with absolute repo paths (to be replaced by the generated one as dogfood).
- Env/bin namespace checked against the other orrerys: their `ORRERY_WORK_DIR` is disjoint from our vars; their bin is `orrery`, ours `0rrery`. No collisions.

## Components

### 1. Package build (`scripts/build-pkg.ts`)

Stages a publishable tree in `dist-pkg/`:

- `index.js` — `bun build packages/cli/src/index.ts --target bun`, shebang preserved/prepended.
- `public/` — copy of `packages/dashboard/dist` (built first).
- `package.json` — name `0rrery`, version `0.1.0`, `bin: { "0rrery": "index.js" }`, `engines: { "bun": ">=1.1" }`, license, repo URL; no dependencies (everything bundled; `bun:sqlite` is runtime-builtin).
- README.md copied in.

`config.ts` change: `dashboardDist` becomes a first-existing-wins candidate list — `join(import.meta.dir, 'public')` (packaged layout), then the existing repo-relative resolve. No other source changes for packaging.

**Acceptance:** an automated test builds the package, runs `npm pack`, installs the tarball into an isolated prefix (`BUN_INSTALL` pointed at a temp dir, `bun install -g <tarball>`), then smoke-tests the installed bin: `0rrery serve` on a scratch port + scratch `ORRERY_DB`, HTTP 200 on `/` (dashboard HTML) and `/api/sessions`, clean shutdown.

### 2. Portable hook command (`0rrery hook`)

New CLI subcommand that runs the existing hook entry (stdin → POST) — a thin wrapper, no logic changes. `0rrery install` writes hook command `0rrery hook` instead of the absolute `bun … hook.ts`.

Migration/dedupe: before adding, `install` removes any existing hook entry whose command contains `0rrery` (matches both the new form and this repo's absolute paths, which contain `0rrery`) — so re-running install never stacks duplicate posts, and this box's legacy entries get replaced. Requires the global bin on PATH; README states global install is required for hooks (bunx alone is fine for `serve`/`import`).

**Amended 2026-07-05 (final review):** the literal `0rrery hook` command proved wrong in the live rollout — hook exec environments don't reliably have `~/.bun/bin` on PATH, and the fail-open design made the resulting ingestion loss invisible (hook-only event types flatlined in the DB while the tailer kept coarse data flowing). `install` now writes the resolved absolute command (`Bun.which('0rrery') ?? execPath+entry`, + ` hook`). settings.json is per-machine, so the literal string's upgrade-portability bought nothing; bun's global bin path is stable across upgrades. Re-run `0rrery install` after moving an install.

### 3. `0rrery service install|uninstall|status`

- **Linux:** writes `~/.config/systemd/user/0rrery.service` (Description, `ExecStart=<abs bin> serve`, `Restart=on-failure`, `WantedBy=default.target`), then `systemctl --user daemon-reload && enable --now`. `uninstall`: disable --now + remove file + daemon-reload. `status`: `systemctl --user is-active` passthrough plus the port from config.
- **macOS:** writes `~/Library/LaunchAgents/com.0pon.0rrery.plist` (ProgramArguments `[<abs bin>, serve]`, RunAtLoad, KeepAlive), `launchctl load -w` / `unload -w`.
- Bin resolution at generation time: `Bun.which('0rrery')`, falling back to the running entry (`process.execPath` + `process.argv[1]`). Regenerate after moving the install; documented.
- Unit/plist generation is pure string-building in its own module (`packages/cli/src/service.ts`) so both platforms are unit-testable; live verification is Linux-only on this box (launchd asserted by generated-content tests).

### 4. `0rrery init`

Guided onboarding, each step idempotent and individually skippable: `--no-hooks`, `--no-service`, `--no-import`.

1. Hooks: run the `install` path (prints what changed).
2. Service: run `service install` (skipped with a note on unsupported platforms).
3. History: sweep `~/.claude/projects/*/*.jsonl` through the import path (new `import --all` doing the glob; init calls it). Ingest is idempotent by ID, so re-running is safe; prints per-file progress and a final session count.

End state after `bun install -g 0rrery && 0rrery init`: service running, hooks live, dashboard at `localhost:7317` populated with the user's entire history.

### 5. README

Rewrite for the installed user, not the contributor: quickstart (`bun install -g 0rrery`, `0rrery init`, open the dashboard), what gets written where (`~/.claude/settings.json` hooks, service unit, `~/.0rrery` data), env vars table, upgrade (`bun install -g 0rrery@latest`, service picks it up on restart), uninstall (service uninstall, hook removal note, `rm -rf ~/.0rrery`), dev section preserved at the bottom.

## Error handling

- `install`/`init` on a box without `~/.claude`: warn and skip hooks (Claude Code not present), continue with the rest.
- `service` on unsupported platforms: clear message, exit 1 (init: skip + note).
- Existing invalid `settings.json`: existing behavior (refuse with message) stands.

## Testing

- Unit: service file generation (both platforms, exact content), install dedupe/migration (legacy `bun …0rrery…hook.ts` entry replaced by `0rrery hook`, idempotent re-run), config dashboardDist candidate order.
- Integration: the npm-pack acceptance test in §1 (build → pack → isolated global install → serve smoke test).
- Live dogfood rollout: on this box, replace the hand-written unit via `0rrery service install`, re-run `0rrery install` (legacy hook entries replaced), verify service active and hooks posting (new spans arriving in the current session).

## Out of scope

Docker/homelab deployment, LAN exposure/auth hardening, Windows, `npm publish` (separate approval-gated action once the artifact verifies), and the **0rrery agent skill** (in-package SKILL.md teaching agents to query their own traces — named future, pairs with the init/copier pattern).
