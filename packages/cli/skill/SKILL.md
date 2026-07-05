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
