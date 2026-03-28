/**
 * instrumentation/index.js
 * Unified hook entry point — auto-instruments all MCP tools for Orrery.
 *
 * Usage:
 *   import { createOrreryHooks } from 'orrery/instrumentation';
 *   const hooks = createOrreryHooks();
 *
 *   // In your PreToolUse handler:
 *   hooks.onToolUse(toolName, toolInput, agentId);
 *
 *   // In your PostToolUse handler:
 *   hooks.onToolResult(toolName, toolInput, result, agentId);
 *
 *   // Agent lifecycle:
 *   hooks.onAgentSpawn({ id, parentId, label });
 *   hooks.onAgentDone(agentId);
 */

import { TopologyEmitter } from '../mcp-emitter.js';
import config from '../orrery.config.js';

// Import individual emitters
import { setupPprEmitter, emitPprMessage, emitPprAgentSpawn, emitPprAgentDone } from './ppr-emitter.js';
import { setupRtkHook, handleToolCall, handleAgentSpawn, handleAgentDone } from './rtk-hook.js';
import { setupHeadroomEmitter, handleCompress, handleRetrieve, handleContextHandoff, handleModelProxy } from './headroom-emitter.js';
import { setupEngramEmitter, handleMemoryOp, handleMemorySave, handleMemorySearch, handleSessionOp } from './engram-emitter.js';

/**
 * Create Orrery hooks instance with auto-instrumentation.
 *
 * @param {object} [options]
 * @param {string} [options.wsUrl] - WebSocket server URL
 * @param {boolean} [options.silent] - Suppress console output
 * @param {string} [options.defaultAgentId] - Default agent ID when not specified
 * @returns {OrreryHooks}
 */
export function createOrreryHooks(options = {}) {
  const wsUrl = options.wsUrl ?? config.wsUrl;
  const silent = options.silent ?? false;
  const defaultAgentId = options.defaultAgentId ?? 'orch';

  // Create emitter
  const emitter = new TopologyEmitter(wsUrl, {
    silent,
    orchestratorId: config.orchestratorId,
  });

  // Initialize all instrumentation modules
  const status = {
    ppr: setupPprEmitter(emitter),
    rtk: setupRtkHook(emitter),
    headroom: setupHeadroomEmitter(emitter),
    engram: setupEngramEmitter(emitter),
  };

  if (!silent) {
    console.log('[orrery] Instrumentation initialized');
    console.log(`[orrery] WebSocket: ${wsUrl}`);
  }

  // Track current agent context
  let currentAgentId = defaultAgentId;

  return new OrreryHooks(emitter, { currentAgentId, status, silent });
}

/**
 * OrreryHooks — unified interface for all instrumentation.
 */
class OrreryHooks {
  constructor(emitter, state) {
    this.emitter = emitter;
    this._currentAgentId = state.currentAgentId;
    this._status = state.status;
    this._silent = state.silent;
    this._agentStack = ['orch']; // Track agent hierarchy
  }

  /**
   * Get current agent ID.
   */
  get agentId() {
    return this._currentAgentId;
  }

  /**
   * Set current agent context.
   */
  setAgent(agentId) {
    this._currentAgentId = agentId;
  }

  /**
   * Get instrumentation status.
   */
  get status() {
    return this._status;
  }

  // ── Tool Lifecycle Hooks ────────────────────────────────────────────────────

  /**
   * Call on PreToolUse — before a tool executes.
   * Auto-routes to appropriate emitter based on tool name.
   *
   * @param {string} toolName - Tool being called
   * @param {object} toolInput - Tool input parameters
   * @param {string} [agentId] - Agent making the call
   */
  onToolUse(toolName, toolInput, agentId) {
    const agent = agentId ?? this._currentAgentId;

    // Route based on tool type
    if (this._isEngramTool(toolName)) {
      this._handleEngramTool(toolName, toolInput, agent);
    } else if (this._isHeadroomTool(toolName)) {
      this._handleHeadroomTool(toolName, toolInput, agent);
    } else if (this._isPprTool(toolName)) {
      this._handlePprTool(toolName, toolInput, agent);
    } else if (toolName === 'Task') {
      this._handleTaskTool(toolInput, agent);
    } else {
      // Generic RTK routing
      handleToolCall(this.emitter, toolName, toolInput, agent);
    }
  }

  /**
   * Call on PostToolUse — after a tool completes.
   * Use for capturing results that affect topology (e.g., Task spawning agent).
   *
   * @param {string} toolName - Tool that was called
   * @param {object} toolInput - Tool input parameters
   * @param {any} result - Tool result
   * @param {string} [agentId] - Agent that made the call
   */
  onToolResult(toolName, toolInput, result, agentId) {
    const agent = agentId ?? this._currentAgentId;

    // Handle Task tool completion — agent was spawned
    if (toolName === 'Task' && result) {
      const spawnedId = this._extractAgentId(result, toolInput);
      if (spawnedId) {
        handleAgentSpawn(this.emitter, {
          agentId: spawnedId,
          parentId: agent,
          description: toolInput?.description ?? spawnedId,
        });
        this._agentStack.push(spawnedId);
      }
    }

    // Handle Headroom compress result — capture hash
    if (toolName === 'mcp__headroom__headroom_compress' && result?.hash) {
      // Hash captured for potential handoff tracking
    }

    // Handle search results for richer logging
    if (toolName === 'mcp__engram__mem_search' && result) {
      const count = Array.isArray(result) ? result.length : result?.count ?? 0;
      handleMemorySearch(this.emitter, {
        agentId: agent,
        query: toolInput?.query ?? '',
        resultCount: count,
      });
    }
  }

  // ── Agent Lifecycle Hooks ───────────────────────────────────────────────────

  /**
   * Call when a sub-agent is spawned.
   */
  onAgentSpawn({ id, parentId, label }) {
    const parent = parentId ?? this._currentAgentId;
    this.emitter.agentSpawn({ id, parentId: parent, label });
    this._agentStack.push(id);

    // Emit handoff from parent to child
    this.emitter.handoff({
      source: parent,
      target: id,
      label: 'spawn context',
    });
  }

  /**
   * Call when an agent completes.
   */
  onAgentDone(agentId) {
    this.emitter.agentDone({ id: agentId });

    // Pop from stack and emit handoff back to parent
    const idx = this._agentStack.indexOf(agentId);
    if (idx > 0) {
      const parent = this._agentStack[idx - 1];
      this.emitter.handoff({
        source: agentId,
        target: parent,
        label: 'result',
      });
      this._agentStack.splice(idx, 1);
    }

    // Update current agent to parent
    if (this._currentAgentId === agentId && this._agentStack.length > 0) {
      this._currentAgentId = this._agentStack[this._agentStack.length - 1];
    }
  }

  // ── Model Call Hook ─────────────────────────────────────────────────────────

  /**
   * Call when an LLM is invoked.
   */
  onModelCall({ model, inputTokens, outputTokens, agentId }) {
    const agent = agentId ?? this._currentAgentId;
    this.emitter.modelCall({
      parentId: agent,
      label: model,
      tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    });
  }

  // ── Permission Hooks ────────────────────────────────────────────────────────

  /**
   * Call when a permission is requested.
   * @returns {string} Permission ID for later resolution
   */
  onPermissionRequest({ label, action, agentId }) {
    const agent = agentId ?? this._currentAgentId;
    return this.emitter.permissionRequest({
      parentId: agent,
      label,
      action,
    });
  }

  /**
   * Call when a permission is resolved.
   */
  onPermissionResolve({ id, status }) {
    this.emitter.permissionResolve({ id, status });
  }

  // ── IPC Hook ────────────────────────────────────────────────────────────────

  /**
   * Call when an IPC message is sent between agents.
   */
  onIpcMessage({ source, target, message }) {
    this.emitter.ipcMessage({ source, target, message });
  }

  // ── Context Handoff Hook ────────────────────────────────────────────────────

  /**
   * Call when context is handed off between agents.
   */
  onHandoff({ source, target, label }) {
    this.emitter.handoff({ source, target, label });
  }

  // ── Direct Emitter Access ───────────────────────────────────────────────────

  /**
   * Get raw emitter for custom events.
   */
  get raw() {
    return this.emitter;
  }

  /**
   * Destroy the hooks instance and close connections.
   */
  destroy() {
    this.emitter.destroy();
  }

  // ── Private Routing Methods ─────────────────────────────────────────────────

  _isEngramTool(name) {
    return name.startsWith('mcp__engram__');
  }

  _isHeadroomTool(name) {
    return name.startsWith('mcp__headroom__');
  }

  _isPprTool(name) {
    return name.startsWith('mcp__ppr__');
  }

  _handleEngramTool(toolName, toolInput, agentId) {
    const op = toolName.replace('mcp__engram__', '');

    // Special handling for saves with rich metadata
    if (op === 'mem_save' && toolInput?.title) {
      handleMemorySave(this.emitter, {
        agentId,
        title: toolInput.title,
        type: toolInput.type,
        project: toolInput.project,
      });
    } else if (op.startsWith('mem_session_')) {
      handleSessionOp(this.emitter, op.replace('mem_session_', ''), {
        agentId,
        sessionId: toolInput?.id ?? toolInput?.session_id,
        project: toolInput?.project,
      });
    } else {
      handleMemoryOp(this.emitter, toolName, toolInput, agentId);
    }
  }

  _handleHeadroomTool(toolName, toolInput, agentId) {
    const op = toolName.replace('mcp__headroom__', '');

    if (op === 'headroom_compress') {
      handleCompress(this.emitter, {
        agentId,
        content: toolInput?.content ?? '',
        hash: '', // Will be filled on result
        originalTokens: toolInput?.content?.length ? Math.ceil(toolInput.content.length / 4) : 0,
      });
    } else if (op === 'headroom_retrieve') {
      handleRetrieve(this.emitter, {
        agentId,
        hash: toolInput?.hash ?? '',
      });
    } else {
      this.emitter.mcpCall({ parentId: agentId, label: `headroom:${op}` });
    }
  }

  _handlePprTool(toolName, toolInput, agentId) {
    const op = toolName.replace('mcp__ppr__', '');

    if (op === 'ipc_publish' || op === 'ipc_request') {
      // Extract source/target from topic if possible
      const topic = toolInput?.topic ?? '';
      const parts = topic.split('.');
      emitPprMessage(this.emitter, {
        source: agentId,
        target: parts[0] ?? 'bus',
        topic,
        payload: toolInput?.payload,
      });
    } else {
      this.emitter.mcpCall({ parentId: agentId, label: `ppr:${op}` });
    }
  }

  _handleTaskTool(toolInput, agentId) {
    // Task tool spawns a sub-agent — emit pending spawn
    // Actual spawn event fires in onToolResult when we have the agent ID
    if (!this._silent) {
      console.log(`[orrery] Task pending: ${toolInput?.description ?? 'sub-agent'}`);
    }
  }

  _extractAgentId(result, input) {
    // Try to extract agent ID from Task result
    if (typeof result === 'string') {
      // Look for agent ID pattern in result
      const match = result.match(/agent[_-]?id[:\s]+([a-zA-Z0-9_-]+)/i);
      if (match) return match[1];
    }
    if (result?.agentId) return result.agentId;
    if (result?.agent_id) return result.agent_id;

    // Fall back to generating from description
    if (input?.description) {
      return input.description.toLowerCase().replace(/\s+/g, '-').slice(0, 20) + '-' + Date.now().toString(36).slice(-4);
    }

    return null;
  }
}

// ── Convenience Exports ───────────────────────────────────────────────────────

export { TopologyEmitter } from '../mcp-emitter.js';
export { config };

// Re-export individual emitters for advanced use
export * from './ppr-emitter.js';
export * from './rtk-hook.js';
export * from './headroom-emitter.js';
export * from './engram-emitter.js';
