/**
 * engram-emitter.js
 * Engram (persistent memory) instrumentation for Orrery.
 *
 * Hook point: Engram MCP tools
 * Event types: mcp_call (labeled engram:read or engram:write)
 *
 * Engram manages persistent memory across sessions.
 * Emit mcp_call events on memory reads/writes with distinct labels
 * so the dashboard can visualize memory operations separately.
 *
 * Usage:
 *   import { TopologyEmitter } from '../mcp-emitter.js';
 *   import { setupEngramEmitter, handleMemoryOp } from './engram-emitter.js';
 *
 *   const emitter = new TopologyEmitter('ws://localhost:4242');
 *   setupEngramEmitter(emitter);
 */

import config from '../orrery.config.js';
import { existsSync } from 'fs';

// Categorize Engram tools by read/write
const ENGRAM_TOOLS = {
  // Read operations
  mem_search: 'read',
  mem_context: 'read',
  mem_get_observation: 'read',
  mem_timeline: 'read',
  mem_stats: 'read',

  // Write operations
  mem_save: 'write',
  mem_save_prompt: 'write',
  mem_update: 'write',
  mem_delete: 'write',
  mem_session_start: 'write',
  mem_session_end: 'write',
  mem_session_summary: 'write',
  mem_capture_passive: 'write',
  mem_suggest_topic_key: 'read', // Technically a read, returns suggestion
};

/**
 * Set up Engram instrumentation.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} [options]
 * @param {string} [options.project] - Project context for filtering
 */
export function setupEngramEmitter(emitter, options = {}) {
  const engramPath = config.tools.engram;

  // Defensive check: verify Engram binary exists
  if (!existsSync(engramPath)) {
    console.warn(`[orrery/engram] Engram binary not found at ${engramPath} — skipping instrumentation`);
    return { active: false, reason: 'binary_not_found' };
  }

  console.log(`[orrery/engram] Engram instrumentation ready at ${engramPath}`);
  console.log('[orrery/engram] Call handleMemoryOp from MCP tool handlers');

  return {
    active: true,
    mode: 'hook_ready',
    project: options.project ?? null,
  };
}

/**
 * Handle an Engram memory operation.
 * Call this from your MCP tool handler when Engram tools are invoked.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {string} toolName - Engram tool name (e.g., 'mem_save', 'mem_search')
 * @param {object} toolInput - Tool input parameters
 * @param {string} [agentId] - Current agent ID (defaults to 'orch')
 */
export function handleMemoryOp(emitter, toolName, toolInput, agentId = 'orch') {
  // Extract the operation name (strip mcp__engram__ prefix if present)
  const opName = toolName.replace(/^mcp__engram__/, '');
  const opType = ENGRAM_TOOLS[opName] ?? 'read';

  const label = opType === 'read'
    ? config.labels.engram.read
    : config.labels.engram.write;

  // Build descriptive label based on operation
  const detail = extractOpDetail(opName, toolInput);

  emitter.mcpCall({
    parentId: agentId,
    label: `${label} ${detail}`,
  });
}

/**
 * Handle memory save operation specifically.
 * Provides richer event data for writes.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} params
 * @param {string} params.agentId - Agent saving memory
 * @param {string} params.title - Memory title
 * @param {string} [params.type] - Memory type (decision, bugfix, etc.)
 * @param {string} [params.project] - Project name
 */
export function handleMemorySave(emitter, params) {
  const { agentId, title, type, project } = params;

  const detail = type ? `[${type}] ${truncate(title, 30)}` : truncate(title, 40);

  emitter.mcpCall({
    parentId: agentId,
    label: `${config.labels.engram.write} ${detail}`,
  });
}

/**
 * Handle memory search operation specifically.
 * Provides richer event data for queries.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} params
 * @param {string} params.agentId - Agent searching
 * @param {string} params.query - Search query
 * @param {number} [params.resultCount] - Number of results returned
 */
export function handleMemorySearch(emitter, params) {
  const { agentId, query, resultCount } = params;

  const detail = resultCount !== undefined
    ? `"${truncate(query, 25)}" (${resultCount})`
    : `"${truncate(query, 30)}"`;

  emitter.mcpCall({
    parentId: agentId,
    label: `${config.labels.engram.read} ${detail}`,
  });
}

/**
 * Handle session lifecycle operations.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {string} operation - 'start', 'end', or 'summary'
 * @param {object} params
 * @param {string} params.agentId - Agent ID
 * @param {string} params.sessionId - Session ID
 * @param {string} [params.project] - Project name
 */
export function handleSessionOp(emitter, operation, params) {
  const { agentId, sessionId, project } = params;

  const label = operation === 'start'
    ? `${config.labels.engram.write} session:${sessionId}`
    : operation === 'end'
    ? `${config.labels.engram.write} session-end`
    : `${config.labels.engram.write} summary`;

  emitter.mcpCall({
    parentId: agentId,
    label: project ? `${label} [${project}]` : label,
  });
}

// ── Helper functions ────────────────────────────────────────────────────────

function extractOpDetail(opName, input) {
  switch (opName) {
    case 'mem_save':
      return truncate(input?.title ?? '', 30);

    case 'mem_search':
      return `"${truncate(input?.query ?? '', 25)}"`;

    case 'mem_context':
      return input?.project ? `[${input.project}]` : '';

    case 'mem_get_observation':
      return `#${input?.id ?? '?'}`;

    case 'mem_update':
      return `#${input?.id ?? '?'}`;

    case 'mem_delete':
      return `#${input?.id ?? '?'}`;

    case 'mem_timeline':
      return `around #${input?.observation_id ?? '?'}`;

    case 'mem_session_start':
      return input?.project ?? '';

    case 'mem_session_end':
      return input?.id ?? '';

    case 'mem_session_summary':
      return input?.project ?? '';

    case 'mem_save_prompt':
      return truncate(input?.content ?? '', 25);

    case 'mem_capture_passive':
      return input?.source ?? '';

    case 'mem_stats':
      return '';

    default:
      return '';
  }
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}
