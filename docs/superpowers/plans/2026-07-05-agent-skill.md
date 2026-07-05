# Agent Introspection Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude can query its own trace history: a compact `GET /api/sessions/:id/summary` endpoint plus a SKILL.md shipped in the npm package and installed to `~/.claude/skills/0rrery/` by `init`.

**Architecture:** `sessionSummary` joins the existing insights query layer (read-only, per-session aggregates in ~5 small SQL statements). The skill is a static markdown asset: staged by `build-pkg`, copied by a new `installSkill` following the same source-resolution pattern as the dashboard assets.

**Tech Stack:** Existing: TypeScript, bun:sqlite, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-agent-skill-design.md`. Read it first.
- Read-only: no schema/ingest changes of any kind.
- `est_cost` stays null-honest (unknown models excluded from $, never guessed).
- Skill body ≤ ~100 lines; content per spec §2 exactly (availability check first + stop-if-down, cheat sheet, glossary, 3 worked examples, output hygiene, project-derivation note).
- Package entry for server exports is `packages/server/src/server-exports.ts` (NOT `src/index.ts` — deleted).
- `bun test` FROM THE REPO ROOT + `bunx tsc --noEmit` green before every commit; paste actual tails. Root currently 142.
- Tests use temp `ORRERY_CLAUDE_DIR` / in-memory stores; never touch `~/.claude` or `~/.0rrery` (the live rollout step is the only exception, and it's deliberate).

---

### Task 1: sessionSummary + route

**Files:**
- Modify: `packages/server/src/insights.ts` (append), `packages/server/src/server-exports.ts` (export), `packages/server/src/server.ts` (route before the detail match at line 95)
- Test: `packages/server/test/insights.test.ts` (append), `test/e2e.test.ts` (append)

**Interfaces:**
- Consumes: `estCost` from `./prices` (already imported in insights.ts), the `seeded()` fixture already defined in insights.test.ts.
- Produces: `sessionSummary(db, id): SessionSummary | null` with
```ts
export type SessionSummary = {
  id: string; project: string | null; status: string; started_at: number; last_event_at: number
  duration_ms: number; tokens_in: number; tokens_out: number; est_cost: number | null
  models: Array<{ model: string; calls: number }>
  top_tools: Array<{ name: string; kind: string; calls: number; errors: number }>
  errors: number; denials: number; subagents: number
  user_messages: number; assistant_turns: number; first_user_message: string | null
}
```
and `GET /api/sessions/:id/summary` (404 `{error}` unknown id). Task 2's SKILL.md documents this endpoint.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/insights.test.ts`:
```ts
import { sessionSummary } from '../src/insights'

test('sessionSummary aggregates one session compactly', () => {
  const s = sessionSummary(seeded().db, 'sA')!
  expect(s).toMatchObject({
    id: 'sA', project: 'alpha', tokens_in: 1010, tokens_out: 2020,
    denials: 1, subagents: 1, user_messages: 1, assistant_turns: 0,
    first_user_message: 'fix the flaky login test',
  })
  expect(s.models).toEqual([
    { model: 'claude-sonnet-5', calls: 1 }, { model: 'mystery-model', calls: 1 },
  ])
  expect(s.top_tools).toEqual([{ name: 'Bash', kind: 'tool', calls: 2, errors: 2 }])
  expect(s.errors).toBe(2)
  expect(s.est_cost).toBeCloseTo(1000 / 1e6 * 3 + 2000 / 1e6 * 15)  // sonnet only; mystery excluded
  expect(s.duration_ms).toBeGreaterThanOrEqual(0)
})

test('sessionSummary returns null for unknown id', () => {
  expect(sessionSummary(seeded().db, 'nope')).toBeNull()
})
```
(`models` ties on calls=1 — if ordering flakes, sort assertion inputs by model name and note it.)

Append to `test/e2e.test.ts`:
```ts
test('session summary endpoint is compact and 404s unknowns', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-e2e-sum-'))
  const srv = startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir }))
  const fixture = new URL('../packages/claude-code/fixtures/fix1.jsonl', import.meta.url).pathname
  const { importSession } = await import('@0rrery/claude-code')
  await importSession(fixture, srv.url, { finalize: true })

  const r = await fetch(`${srv.url}/api/sessions/fix1/summary`)
  expect(r.status).toBe(200)
  const s = await r.json() as any
  expect(s.project).toBe('myproj')
  expect(s.denials).toBe(1)
  expect(s.models.length).toBeGreaterThan(0)
  expect(s.first_user_message).toBeTruthy()
  expect(JSON.stringify(s).length).toBeLessThan(2000)  // the whole point: compact

  expect((await fetch(`${srv.url}/api/sessions/nope/summary`)).status).toBe(404)
  srv.stop()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/insights.test.ts test/e2e.test.ts`
Expected: FAIL — `sessionSummary` not exported; e2e summary fetch returns 200 with the FULL detail? No — `/api/sessions/fix1/summary` doesn't match the detail regex (`[^/]+` excludes slashes), so it 404s: the e2e expects 200. Both red.

- [ ] **Step 3: Implement**

Append to `packages/server/src/insights.ts` (SessionSummary type from Interfaces above, then):
```ts
export function sessionSummary(db: Database, id: string): SessionSummary | null {
  const s = db.query('SELECT * FROM sessions WHERE id = ?').get(id) as any
  if (!s) return null
  const models = db.query(`SELECT name model, COUNT(*) calls,
      SUM(COALESCE(json_extract(attrs, '$.input_tokens'), 0)) tin,
      SUM(COALESCE(json_extract(attrs, '$.output_tokens'), 0)) tout
    FROM spans WHERE session_id = ? AND kind = 'llm'
    GROUP BY name ORDER BY calls DESC, model`).all(id) as any[]
  const top_tools = db.query(`SELECT name, kind, COUNT(*) calls, SUM(status = 'error') errors
    FROM spans WHERE session_id = ? AND kind IN ('tool', 'mcp')
    GROUP BY name, kind ORDER BY calls DESC LIMIT 10`).all(id) as any[]
  const counts = db.query(`SELECT
      COALESCE(SUM(kind IN ('tool', 'mcp') AND status = 'error'), 0) errors,
      COALESCE(SUM(kind = 'agent'), 0) subagents
    FROM spans WHERE session_id = ?`).get(id) as any
  const denials = (db.query(`SELECT COUNT(*) c FROM events WHERE session_id = ?
    AND type = 'permission.resolved' AND json_extract(attrs, '$.outcome') = 'denied'`).get(id) as any).c
  const msgs = db.query(`SELECT
      COALESCE(SUM(type = 'message.user'), 0) user_messages,
      COALESCE(SUM(type = 'message.assistant'), 0) assistant_turns
    FROM events WHERE session_id = ?`).get(id) as any
  const first = db.query(`SELECT json_extract(attrs, '$.preview') p FROM events
    WHERE session_id = ? AND type = 'message.user' ORDER BY ts LIMIT 1`).get(id) as any
  const costs = models.map(m => estCost(m.model, m.tin, m.tout)).filter((c): c is number => c !== null)
  return {
    id: s.id, project: s.project, status: s.status, started_at: s.started_at, last_event_at: s.last_event_at,
    duration_ms: s.last_event_at - s.started_at,
    tokens_in: models.reduce((a, m) => a + m.tin, 0), tokens_out: models.reduce((a, m) => a + m.tout, 0),
    est_cost: costs.length ? costs.reduce((a, c) => a + c, 0) : null,
    models: models.map(m => ({ model: m.model, calls: m.calls })),
    top_tools, errors: counts.errors, denials, subagents: counts.subagents,
    user_messages: msgs.user_messages, assistant_turns: msgs.assistant_turns,
    first_user_message: first?.p ?? null,
  }
}
```

Export `sessionSummary` (+ `type SessionSummary`) from `packages/server/src/server-exports.ts`.

In `packages/server/src/server.ts`, import `sessionSummary` from `./insights` and add IMMEDIATELY BEFORE the detail match (line 95, `const m = path.match(/^\/api\/sessions\/([^/]+)$/)`):
```ts
        const sm = path.match(/^\/api\/sessions\/([^/]+)\/summary$/)
        if (sm && req.method === 'GET') {
          const s = sessionSummary(store.db, decodeURIComponent(sm[1]))
          return s ? json(s) : json({ error: `session ${decodeURIComponent(sm[1])}: 404` }, 404)
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/insights.test.ts test/e2e.test.ts`, root `bun test`, `bunx tsc --noEmit`.
Expected: root 145 pass / 0 fail (142 + 3).

- [ ] **Step 5: Commit**

```bash
git add packages/server test/e2e.test.ts && git commit -m "Add compact session summary endpoint"
```

---

### Task 2: SKILL.md + install + packaging + live rollout

**Files:**
- Create: `packages/cli/skill/SKILL.md`, `packages/cli/src/skill.ts`
- Modify: `packages/cli/src/index.ts:80` (init gains the skill step), `scripts/build-pkg.ts` (stage skill/, files array), `test/init.test.ts` (extend), `test/pkg.test.ts` (extend), `README.md` (Agent skill section + init row)
- Test: `packages/cli/test/skill.test.ts` (new)

**Interfaces:**
- Consumes: `sessionSummary` endpoint from Task 1 (documented in SKILL.md); `claudeDir()`, `flags` pattern in the existing `case 'init'`.
- Produces: `skillSourceDir(): string | null` and `installSkill(claudeDir: string, srcDir: string): string` from `packages/cli/src/skill.ts`; `init --no-skill` flag.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/skill.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkill, skillSourceDir } from '../src/skill'

test('skillSourceDir finds the repo skill assets', () => {
  const src = skillSourceDir()
  expect(src).not.toBeNull()
  expect(existsSync(join(src!, 'SKILL.md'))).toBe(true)
})

test('installSkill copies and overwrites idempotently', () => {
  const claude = mkdtempSync(join(tmpdir(), '0rrery-skill-'))
  const src = mkdtempSync(join(tmpdir(), '0rrery-skillsrc-'))
  writeFileSync(join(src, 'SKILL.md'), 'v1')
  const dest = installSkill(claude, src)
  expect(dest).toBe(join(claude, 'skills', '0rrery'))
  expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('v1')
  writeFileSync(join(src, 'SKILL.md'), 'v2')
  installSkill(claude, src)
  expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('v2')
})
```

Extend `test/init.test.ts` — inside the existing `init --no-service` test, after the hooks assertion add:
```ts
    expect(existsSync(join(claudeDir, 'skills', '0rrery', 'SKILL.md'))).toBe(true)
```
(add `existsSync` to its fs imports.)

Extend `test/pkg.test.ts` — after the `expect(existsSync(bin)).toBe(true)` line add:
```ts
  const { realpathSync } = await import('node:fs')
  const pkgDir = join(realpathSync(bin), '..')
  expect(existsSync(join(pkgDir, 'skill', 'SKILL.md'))).toBe(true)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/test/skill.test.ts test/init.test.ts`
Expected: FAIL — `../src/skill` missing; init test fails on the new skills assertion. (Don't run pkg.test yet — it's slow; it runs in Step 4.)

- [ ] **Step 3: Implement**

Create `packages/cli/skill/SKILL.md` with EXACTLY this content:
````markdown
---
name: 0rrery
description: Use when the user asks about past agent sessions, AI spend/cost, tool failures, denied permissions, or what agents did or touched — query the local 0rrery trace database over HTTP.
---

# 0rrery — query your own trace history

0rrery records every Claude Code session on this machine (tools, subagents, LLM calls, permissions) in a local SQLite DB behind a localhost HTTP API. Use it to answer questions about past sessions, spend, failures, and agent activity.

## Before anything: is it running?

```bash
curl -s localhost:${ORRERY_PORT:-7317}/api/stats
```

If this fails, 0rrery isn't running — tell the user to start it (`systemctl --user start 0rrery` or `0rrery serve`) and STOP. Never retry-loop against a down server.

## Endpoints

All accept `project=<name>`, `from=<epoch ms>`, `to=<epoch ms>` query params unless noted. Base: `localhost:${ORRERY_PORT:-7317}`.

| Endpoint | Answers |
|---|---|
| `GET /api/insights/spend` | tokens + estimated $ by day × model × project |
| `GET /api/insights/tool-health` | per-tool calls, errors, denials |
| `GET /api/insights/projects` | per-project sessions, wall time, tokens, est $ |
| `GET /api/insights/sprawl` | global actor graph (agents → models → tools), node ids are `kind:label` |
| `GET /api/insights/surface` | external domains contacted + MCP servers used |
| `GET /api/insights/footprint` | files/dirs agents touched (Read/Write/Edit) |
| `GET /api/sessions?q=&project=&status=&from=&to=&limit=` | find sessions (q searches first-message previews + project names) |
| `GET /api/sessions/<id>/summary` | ONE compact object: duration, tokens, est $, models, top tools, errors, denials, subagents, first message |
| `GET /api/sessions/<id>` | full span/event detail — LARGE (thousands of spans); prefer summary |

## Reading the numbers

- `est_cost` is an ESTIMATE from a static price table; models without a known price count tokens but are EXCLUDED from $ totals — say so when reporting money.
- `denials` = tool calls a user or policy rejected. `errors` = tool calls that failed.
- `project` = the working directory's last path segment; derive the current session's from `pwd`.

## Worked examples

**"What did I spend this week?"**
```bash
FROM=$(( ($(date +%s) - 7*86400) * 1000 ))
curl -s "localhost:${ORRERY_PORT:-7317}/api/insights/spend?from=$FROM" -o /tmp/spend.json
python3 -c "
import json; rows = json.load(open('/tmp/spend.json'))
known = sum(r['est_cost'] for r in rows if r['est_cost'] is not None)
unpriced = {r['model'] for r in rows if r['est_cost'] is None}
print(f'~\${known:.2f} est.', f'+ unpriced models {sorted(unpriced)}' if unpriced else '')"
```

**"What keeps failing in this repo?"**
```bash
curl -s "localhost:${ORRERY_PORT:-7317}/api/insights/tool-health?project=$(basename "$PWD")" -o /tmp/th.json
python3 -c "
import json
for r in json.load(open('/tmp/th.json')):
    if r['calls'] >= 5 and r['errors'] / r['calls'] > 0.05: print(r['name'], f\"{r['errors']}/{r['calls']} errors\", f\"{r['denials']} denied\")"
```

**"What did my last session do?"**
```bash
ID=$(curl -s "localhost:${ORRERY_PORT:-7317}/api/sessions?limit=1" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")
curl -s "localhost:${ORRERY_PORT:-7317}/api/sessions/$ID/summary"
```

## Output hygiene

Responses are JSON. Aggregate with `python3 -c` or `jq`, and write anything over ~2KB to a file first, then read the file — piped output can be rewritten by other tooling in the shell path.
````

Create `packages/cli/src/skill.ts`:
```ts
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Bundled entry: dist-pkg/index.js with dist-pkg/skill; repo: packages/cli/src with packages/cli/skill.
export function skillSourceDir(): string | null {
  const candidates = [join(import.meta.dir, 'skill'), join(import.meta.dir, '../skill')]
  return candidates.find(existsSync) ?? null
}

export function installSkill(claudeDir: string, srcDir: string): string {
  const dest = join(claudeDir, 'skills', '0rrery')
  mkdirSync(dest, { recursive: true })
  cpSync(srcDir, dest, { recursive: true })
  return dest
}
```

In `packages/cli/src/index.ts`: `import { installSkill, skillSourceDir } from './skill'`, and inside `case 'init'` insert between the hooks block and the service block:
```ts
    if (!flags.has('--no-skill')) {
      console.log('› skill')
      const src = skillSourceDir()
      if (!existsSync(claudeDir())) console.log(`  ${claudeDir()} not found — skipping skill`)
      else if (!src) console.log('  skill assets not found — skipping')
      else console.log(`  installed ${installSkill(claudeDir(), src)}`)
    }
```

In `scripts/build-pkg.ts`: after the README cpSync add `cpSync(join(root, 'packages/cli/skill'), join(out, 'skill'), { recursive: true })`, and change the files array to `files: ['index.js', 'public', 'skill', 'README.md']`.

README: in the commands table change the `init` row description to `hooks + agent skill + service + history import, idempotently`; add after the Configuration section:
```markdown
## Agent skill

`init` installs a skill at `~/.claude/skills/0rrery/` that teaches Claude to answer questions like "what did I spend this week", "what keeps failing in this repo", or "what did my last session do" by querying the local API. Skip with `--no-skill`; remove with `rm -rf ~/.claude/skills/0rrery`.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/test/skill.test.ts test/init.test.ts`, then `bun test test/pkg.test.ts` (slow), then root `bun test` and `bunx tsc --noEmit`.
Expected: root 147 pass / 0 fail (145 + 2 new skill tests; init/pkg tests extended in place).

- [ ] **Step 5: Commit**

```bash
git add packages/cli scripts/build-pkg.ts test/init.test.ts test/pkg.test.ts README.md && git commit -m "Ship agent introspection skill, installed by init"
```

- [ ] **Step 6: Live rollout (this box — deliberate real mutation)**

```bash
bun run build:pkg && cp -r dist-pkg/. /home/mlayug/node_modules/0rrery/   # established propagation for the file:-pinned install
systemctl --user restart 0rrery && sleep 6 && systemctl --user is-active 0rrery
/home/mlayug/.bun/bin/0rrery init --no-service --no-import   # hooks re-run idempotently + skill installs
ls -la ~/.claude/skills/0rrery/ && head -4 ~/.claude/skills/0rrery/SKILL.md
```
Then execute the SKILL.md's three worked examples EXACTLY as written against the live server, and sanity-check each answer (spend has a number + the unpriced-fable note; tool-health lists something plausible for this repo; last-session summary is this session or a recent one). OBSERVED output only; the examples themselves write to files per their own hygiene rules — follow them. Report all three outputs.

---

## Out of scope (per spec)

Fleet view (arc 3/3), MCP-server skill variant, write operations, non-Claude-Code agents.
