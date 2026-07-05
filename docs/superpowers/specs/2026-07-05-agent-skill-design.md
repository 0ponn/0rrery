# 0rrery Agent Introspection Skill Design (durable-value arc 2/3)

Date: 2026-07-05
Status: approved pending user spec review
Parent: `2026-07-05-insights-design.md` (the endpoints this consumes; its "skill-readiness constraint" is the contract), `2026-07-05-self-host-design.md` (init/packaging patterns). Borrowed pattern recorded there: CaseyHaralson/orrery ships SKILL.md files in-package and copies them at init.

## Summary

Claude gains the ability to query its own trace history: a SKILL.md shipped in the npm package and installed into `~/.claude/skills/0rrery/` by `init`, teaching agents to answer spend/tool-health/history questions via the local insights API — plus one new compact endpoint, `GET /api/sessions/:id/summary`, so per-session questions cost ~1KB of context instead of a full span dump.

## Decisions (user-approved 2026-07-05)

- **Scope:** skill + the summary endpoint (approved over skill-only; session detail returns 4000+ spans on big sessions, context-hostile).
- **Install:** an `init` step with `--no-skill`, overwrite-on-rerun (upgrades propagate). No separate subcommand (YAGNI).
- **Skill budget:** under ~100 lines of body — skills are context.

## Components

### 1. `sessionSummary(db, id)` — `packages/server/src/insights.ts`

Returns `null` for unknown id, else:

```ts
{
  id, project, status, started_at, last_event_at,        // from the session row
  duration_ms,                                            // last_event_at - started_at
  tokens_in, tokens_out, est_cost,                        // llm spans; est_cost null-honest per prices.ts
  models: [{ model, calls }],                             // llm spans grouped by name, calls desc
  top_tools: [{ name, kind, calls, errors }],             // tool+mcp spans, top 10 by calls
  errors, denials,                                        // error-status tool/mcp spans; denied via permission.resolved outcome=denied
  subagents,                                              // agent-kind span count
  user_messages, assistant_turns,                         // count of message.user events; count of message.assistant events
  first_user_message,                                     // earliest message.user preview attr, null if none
}
```

Route: `GET /api/sessions/:id/summary` (regex alongside the existing detail route, BEFORE it so `/summary` isn't captured as an id), 404 `{error}` on unknown session, inside the existing try/catch. Exported through `server-exports.ts` (the package entry — not `src/index.ts`).

### 2. The skill — `packages/cli/skill/SKILL.md`

Frontmatter:
```yaml
---
name: 0rrery
description: Use when the user asks about past agent sessions, AI spend/cost, tool failures, denied permissions, or what agents did or touched — query the local 0rrery trace database over HTTP.
---
```

Body (≤ ~100 lines), containing exactly:
- Availability check first: `curl -s localhost:${ORRERY_PORT:-7317}/api/stats` — if unreachable, say 0rrery isn't running (`0rrery serve` or `systemctl --user start 0rrery`) and STOP; never retry-loop.
- Endpoint cheat sheet with one exact curl example each: `/api/insights/spend|tool-health|projects|sprawl|surface|footprint` (+ `project`/`from`/`to` params, epoch ms), `/api/sessions?q=&project=&status=&from=&to=`, `/api/sessions/:id/summary`, `/api/sessions/:id` (full detail — marked "large; prefer summary").
- Field glossary one-liners (est_cost estimated + unknown-price models excluded from $; denials = user/policy-denied tool calls; sprawl node ids are `kind:label`).
- Worked examples: "what did I spend this week" (from = now-7d epoch ms → spend, sum est_cost, tokens for null-cost models), "what keeps failing in this repo" (tool-health?project=<dir name>, error rate = errors/calls), "what did my last session do" (sessions?limit=1 → id → summary).
- Output hygiene: responses are JSON — pipe through `python3 -c`/`jq` for aggregation; write anything over ~2KB to a file and read that (piped output may be rewritten by other tooling).
- Project = the cwd's last path segment; the current session's project is knowable from pwd.

### 3. Packaging + install

- `scripts/build-pkg.ts` stages `packages/cli/skill/` → `dist-pkg/skill/`; `files` array gains `"skill"`.
- `packages/cli/src/install.ts` (or a small `skill.ts`) gains `installSkill(claudeDir: string, srcDir: string): string` — `mkdirSync` + `cpSync(srcDir, join(claudeDir, 'skills', '0rrery'), { recursive: true })`, returns the dest path. Overwrites existing (upgrade path).
- Source dir resolution mirrors the dashboard-assets pattern: first-existing of `join(import.meta.dir, '../skill')` relative to the bundled entry (`dist-pkg/skill`) and the repo path (`packages/cli/skill`).
- `init` gains step "skill" between hooks and service, skipped by `--no-skill`, and skipped with a note when the claude dir doesn't exist (same guard as hooks).

### 4. README

Commands table: `init` description gains "+ agent skill". A short "Agent skill" section: what it enables (ask Claude about your sessions/spend/failures), where it installs, `--no-skill` to opt out, removal = delete `~/.claude/skills/0rrery`.

## Error handling

- Summary of unknown session → 404 `{error: 'session <id>: 404'}`-shaped like the detail route.
- Skill install with missing `~/.claude` → warn + skip (init continues).
- Skill's own runtime failure mode (server down) is handled inside SKILL.md instructions (check stats, stop gracefully).

## Testing

- Unit: `sessionSummary` against the seeded fixture store (token/model/tool/denial/subagent counts, first_user_message, null for unknown id); `installSkill` copy + overwrite idempotence via temp dirs.
- E2E: summary endpoint shape + 404 over the imported fixture; init `--no-service` copies the skill into a temp `ORRERY_CLAUDE_DIR`.
- Packaging: the pkg acceptance test additionally asserts `skill/SKILL.md` exists in the installed tree.
- Live rollout: re-run init on this box (service/import skipped), verify `~/.claude/skills/0rrery/SKILL.md`, then execute the SKILL.md's own worked-example curls against live data and sanity-check the answers (observed output; file-and-read anything large).

## Out of scope

Fleet view (arc 3/3), MCP-server variant of the skill, skill auto-update notifications, teaching the skill write operations (introspection is read-only by design), multi-agent-tool targets (Claude Code only for v1).
