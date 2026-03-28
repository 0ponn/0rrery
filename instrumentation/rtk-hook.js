/**
 * rtk-hook.js
 * RTK (Rust Token Killer) PreToolUse hook integration for Orrery.
 *
 * Hook point: Claude Code PreToolUse hook
 * Event types: mcp_call, file_access, api_call
 *
 * RTK is hooked via PreToolUse — intercept tool calls before RTK processes
 * them to emit topology events.
 *
 * Usage:
 *   import { TopologyEmitter } from '../mcp-emitter.js';
 *   import { setupRtkHook, handleToolCall } from './rtk-hook.js';
 *
 *   const emitter = new TopologyEmitter('ws://localhost:4242');
 *   setupRtkHook(emitter);
 *
 *   // In your PreToolUse hook handler:
 *   handleToolCall(emitter, toolName, toolInput, agentId);
 */

import config from '../orrery.config.js';
import { existsSync } from 'fs';

// Tool categorization for topology visualization
const TOOL_CATEGORIES = {
  // File access tools
  Read: 'file',
  Write: 'file',
  Edit: 'file',
  Glob: 'file',
  Grep: 'file',
  NotebookEdit: 'file',

  // MCP tools (external services)
  mcp__engram__: 'mcp',
  mcp__headroom__: 'mcp',
  mcp__ppr__: 'mcp',

  // API calls
  WebFetch: 'api',
  WebSearch: 'api',

  // Agent management
  Task: 'agent',

  // Shell/system
  Bash: 'mcp',
};

/**
 * Set up RTK PreToolUse hook instrumentation.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} [options]
 * @param {string} [options.currentAgentId] - ID of the current agent context
 */
export function setupRtkHook(emitter, options = {}) {
  const rtkPath = config.tools.rtk;

  // Defensive check: verify RTK binary exists
  if (!existsSync(rtkPath)) {
    console.warn(`[orrery/rtk] RTK binary not found at ${rtkPath} — skipping instrumentation`);
    return { active: false, reason: 'binary_not_found' };
  }

  console.log(`[orrery/rtk] RTK instrumentation ready at ${rtkPath}`);
  console.log('[orrery/rtk] Call handleToolCall() from your PreToolUse hook');

  return {
    active: true,
    mode: 'hook_ready',
    currentAgentId: options.currentAgentId ?? 'orch',
  };
}

/**
 * Handle a tool call from PreToolUse hook.
 * Call this in your Claude Code hook handler.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {string} toolName - Name of the tool being called
 * @param {object} toolInput - Tool input parameters
 * @param {string} [agentId] - Current agent ID (defaults to 'orch')
 */
export function handleToolCall(emitter, toolName, toolInput, agentId = 'orch') {
  const category = categorize(toolName);

  switch (category) {
    case 'file':
      emitter.fileAccess({
        parentId: agentId,
        label: extractFileLabel(toolName, toolInput),
      });
      break;

    case 'mcp':
      emitter.mcpCall({
        parentId: agentId,
        label: extractMcpLabel(toolName, toolInput),
      });
      break;

    case 'api':
      emitter.apiCall({
        parentId: agentId,
        label: extractApiLabel(toolName, toolInput),
      });
      break;

    case 'agent':
      // Agent spawns are handled separately via Task tool results
      // Just log the intent here
      console.log(`[orrery/rtk] Agent spawn pending: ${toolInput?.description ?? 'unknown'}`);
      break;

    default:
      // Unknown tool — emit as MCP call
      emitter.mcpCall({
        parentId: agentId,
        label: toolName,
      });
  }
}

/**
 * Handle Task tool completion to emit agent_spawn.
 * Call this when a Task tool returns successfully.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} taskResult
 * @param {string} taskResult.agentId - Spawned agent ID
 * @param {string} taskResult.parentId - Parent agent ID
 * @param {string} taskResult.description - Agent description/label
 */
export function handleAgentSpawn(emitter, taskResult) {
  emitter.agentSpawn({
    id: taskResult.agentId,
    parentId: taskResult.parentId ?? 'orch',
    label: taskResult.description ?? taskResult.agentId,
  });
}

/**
 * Handle agent completion.
 * Call this when an agent finishes its task.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {string} agentId - Completed agent ID
 */
export function handleAgentDone(emitter, agentId) {
  emitter.agentDone({ id: agentId });
}

// ── Categorization helpers ────────────────────────────────────────────────────

function categorize(toolName) {
  // Check direct match
  if (TOOL_CATEGORIES[toolName]) {
    return TOOL_CATEGORIES[toolName];
  }

  // Check prefix match (for MCP tools like mcp__engram__mem_save)
  for (const [prefix, category] of Object.entries(TOOL_CATEGORIES)) {
    if (prefix.endsWith('__') && toolName.startsWith(prefix)) {
      return category;
    }
  }

  return 'unknown';
}

function extractFileLabel(toolName, input) {
  // Extract file path from tool input
  const path = input?.file_path ?? input?.path ?? input?.pattern ?? '';
  const shortPath = path.split('/').slice(-2).join('/');

  switch (toolName) {
    case 'Read':
      return `read: ${shortPath}`;
    case 'Write':
      return `write: ${shortPath}`;
    case 'Edit':
      return `edit: ${shortPath}`;
    case 'Glob':
      return `glob: ${input?.pattern ?? '*'}`;
    case 'Grep':
      return `grep: ${truncate(input?.pattern ?? '', 20)}`;
    default:
      return `${toolName}: ${shortPath}`;
  }
}

function extractMcpLabel(toolName, input) {
  // Parse MCP tool name (format: mcp__server__tool)
  const parts = toolName.split('__');
  if (parts.length >= 3) {
    const server = parts[1];
    const tool = parts.slice(2).join('_');
    return `${server}:${tool}`;
  }

  // Bash command
  if (toolName === 'Bash') {
    const cmd = input?.command ?? '';
    const firstWord = cmd.split(/\s+/)[0];
    return `bash: ${firstWord}`;
  }

  return toolName;
}

function extractApiLabel(toolName, input) {
  switch (toolName) {
    case 'WebFetch':
      try {
        const url = new URL(input?.url ?? '');
        return `fetch: ${url.hostname}`;
      } catch {
        return 'WebFetch';
      }
    case 'WebSearch':
      return `search: ${truncate(input?.query ?? '', 25)}`;
    default:
      return toolName;
  }
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}
