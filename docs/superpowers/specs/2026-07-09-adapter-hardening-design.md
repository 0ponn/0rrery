# 0rrery Adapter Template Hardening + ADAPTERS.md Design (multi-tool 2/N)

Date: 2026-07-09
Status: approved (continuous-execution mode; 0PO-481)
Parent: `2026-07-09-codex-adapter-design.md` final review's template notes. Gemini parked (demand-driven; decision recorded in 0PO-481).

## Summary

The adapter pattern gets hardened before anyone copies it a third time: compile-time safety via generics, a `finalize` hook closing adapter-specific open spans, collision-safe event ids for merged multi-file sessions, and the small correctness leftovers — then the contract is written down in `ADAPTERS.md` for external contributors.

## Components

### 1. Generics over the `any` triple

- `importTranscript<S>(path, url, fromByte, state: S, finalize, parser: Parser<S>)` where
  ```ts
  export type Parser<S> = {
    parse: (raw: string, state: S) => IngestOp[]
    finalize?: (state: S, maxTs: number) => IngestOp[]
  }
  ```
  Backward compatibility: the existing positional `parse` function param becomes the `Parser` object; ALL call sites are in-repo (importer default, codex tailer, CLI sniff, sweep, tests) — update them all; no external API stability promise exists pre-1.0.
- `FileState<S> = { offset: number; state: S }`; `loadOffsets<S>(path, revive: (json: unknown) => S)`; `saveOffsets<S>(path, files: Map<string, FileState<S>>)`.
- Claude default parser object: `{ parse: parseTranscriptLine }` (its agent-close/session-end logic stays where it is — see §2).

### 2. `finalize` hook

- `importTranscript` finalize step becomes: (a) if `parser.finalize`, append `parser.finalize(state, maxTs)`; (b) the existing Claude-specific agent-close moves INTO a claude parser object's finalize (`packages/claude-code`), preserving current emission exactly (agent-close fires per-read when `state.agentId` set, session.end when top-level finalize) — the importer keeps only the generic session.end emission on `finalize=true` (unchanged condition semantics; the agent-close's per-read behavior is preserved by calling `parser.finalize` on every read, with the Claude finalize implementation reproducing today's guards internally. The `finalize=true` flag is passed through so session.end stays importer-level).
  - Simplification allowed if cleaner: keep agent-close in the importer under a `'agentId' in state` guard (today's shipped form) and let `parser.finalize` be purely additive for new adapters. Implementer picks the one with the byte-identical Claude suite; plan specifies the additive form (lower risk).
- Codex parser object gains `finalize: (state, maxTs) => state.openTurnId ? [{ op: 'span.end', id: 'llm:' + state.openTurnId, ts: maxTs, status: 'ok' }] : []` — closes crashed-rollout turns at import-finalize. Live tailing still leaves them open (truthful running), same posture as Claude.

### 3. Event-id salting for merged sessions

Codex subagent-thread files share `session_id` with their parent; today `evt:msg:<sid>:<ts>:<role>` and `evt:stop:<sid>:<ts>` collide across files in the same millisecond (theoretical today, probable with parallel subagents). Fix with **re-import compatibility as the constraint**:

- `CodexState` gains `threadId: string | null` = `payload.id` from session_meta (distinct from session_id on subagent threads, equal on main files).
- Event ids become `evt:msg:<sid>:<ts>:<role>` UNCHANGED when `threadId === sessionId` (main files — the overwhelming majority; re-imports stay idempotent against existing DB rows), and `evt:msg:<sid>:<threadId>:<ts>:<role>` when they differ (subagent threads). Same rule for `evt:stop`.
- Accepted consequence: subagent-thread events already ingested under unsalted ids are orphaned by this change (no code path emits those ids again); the next re-import inserts salted copies alongside them, so each pre-fix subagent event appears twice in the merged timeline. Observed on the FOSSINT session: 26 events (12 + 14 across the two thread files), 40→66, each salted row pairing an existing unsalted row at identical (ts, type, attrs). Bounded (once per pre-fix subagent event, stable under further re-imports — verified: a second import adds 0), display-only, accepted. Optional one-time cleanup: delete unsalted `evt:msg:`/`evt:stop:` rows that have a salted twin at the same (session_id, ts, type, attrs). No drop occurred in this instance; the same-millisecond collision drop the salt guards against remains theoretical on this host.

### 4. Small correctness leftovers

- `sweep.ts`: extract `importOne(path, url, parser?, label?)` used by both loops.
- Codex `session.start` gains `cwd: payload.cwd` (schema already carries cwd).
- Clone-contract comment at the snapshot site in importer.ts: `// adapter state must be flat: scalars and Sets only — nested objects/Maps would alias through this rollback clone`.

### 5. `ADAPTERS.md` (repo root)

Written for an external contributor, ≤ ~120 lines: what an adapter is (package exporting `Parser<S>` + `newState` + `reviveState`); the state rules (flat, scalars + Sets, revive must default malformed fields); ids must be globally unique and deterministic (idempotent re-ingest is the contract — derive from source-file identifiers, never from parse time); per-adapter offset files; wiring points (tailer, import sniff, sweep) with file/line pointers; the testing pattern that caught real bugs twice (fixture TDD + "parse your own real files: zero throws, zero parseOps rejections"); what NOT to do (no hooks required, no schema changes without review, no cumulative-counter summing without checking the source semantics).

## Testing

- Existing 187 suite = the byte-identical guard for Claude paths (generics must not change emissions).
- New unit tests: codex finalize closes an open turn (and emits nothing when none); salted vs unsalted event ids (main-file ids byte-identical to today's — regression-pinned against the existing fixture expectations; subagent-thread fixture line added with differing id); tsc negative check noted in report (a deliberately mismatched Parser/state pair fails to compile — verify manually, not committable).
- E2E: re-import the codex fixture twice into one server — event count identical after the second import (idempotency pin for main files).
- Live rollout: deploy, re-run `import --all`, verify the previously-open crashed-rollout turn spans (if any) close under finalize; confirm the FOSSINT merged session's event count changes only by the accepted bounded duplication; root suite + service healthy.

## Out of scope

Gemini (parked, demand-driven), new adapters, structuredClone migration (contract documented instead), npm release (tag whenever).
