/**
 * headroom-emitter.js
 * Headroom (context compression) instrumentation for Orrery.
 *
 * Hook point: Headroom MCP tools
 * Event types: model_call (with token counts), handoff
 *
 * Headroom manages context compression and model proxy operations.
 * Emit model_call events when Headroom proxies context, and handoff
 * events when context transitions between agents/sessions.
 *
 * Usage:
 *   import { TopologyEmitter } from '../mcp-emitter.js';
 *   import { setupHeadroomEmitter, handleCompress, handleRetrieve } from './headroom-emitter.js';
 *
 *   const emitter = new TopologyEmitter('ws://localhost:4242');
 *   setupHeadroomEmitter(emitter);
 */

import config from '../orrery.config.js';

// Track compression operations for context handoffs
const compressionCache = new Map();

/**
 * Set up Headroom instrumentation.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} [options]
 * @param {string} [options.sessionId] - Current session ID for tracking
 */
export function setupHeadroomEmitter(emitter, options = {}) {
  console.log('[orrery/headroom] Headroom instrumentation ready');
  console.log('[orrery/headroom] Call handleCompress/handleRetrieve from MCP tool handlers');

  return {
    active: true,
    mode: 'hook_ready',
    sessionId: options.sessionId ?? `session-${Date.now()}`,
  };
}

/**
 * Handle headroom_compress operation.
 * Emits model_call with estimated token savings.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} params
 * @param {string} params.agentId - Agent performing compression
 * @param {string} params.content - Content being compressed
 * @param {string} params.hash - Resulting compression hash
 * @param {number} [params.originalTokens] - Original token count
 * @param {number} [params.compressedTokens] - Compressed token count
 */
export function handleCompress(emitter, params) {
  const { agentId, content, hash, originalTokens, compressedTokens } = params;

  // Estimate tokens if not provided (rough: 4 chars per token)
  const estOriginal = originalTokens ?? Math.ceil(content.length / 4);
  const estCompressed = compressedTokens ?? Math.ceil(estOriginal * 0.3); // ~70% compression

  // Cache for tracking retrieval handoffs
  compressionCache.set(hash, {
    agentId,
    timestamp: Date.now(),
    tokens: estOriginal,
  });

  // Emit model call for compression operation
  emitter.mcpCall({
    parentId: agentId,
    label: config.labels.headroom.compress,
  });

  // Also emit the token savings as a model operation
  emitter.modelCall({
    parentId: agentId,
    label: `compress (${estOriginal} → ${estCompressed} tok)`,
    tokens: -1 * (estOriginal - estCompressed), // Negative = savings
  });
}

/**
 * Handle headroom_retrieve operation.
 * Emits handoff when retrieving context compressed by another agent.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} params
 * @param {string} params.agentId - Agent retrieving content
 * @param {string} params.hash - Compression hash being retrieved
 * @param {number} [params.tokens] - Tokens in retrieved content
 */
export function handleRetrieve(emitter, params) {
  const { agentId, hash, tokens } = params;

  // Check if this was compressed by a different agent (handoff scenario)
  const cached = compressionCache.get(hash);

  emitter.mcpCall({
    parentId: agentId,
    label: config.labels.headroom.retrieve,
  });

  if (cached && cached.agentId !== agentId) {
    // Context handoff: content moving between agents
    emitter.handoff({
      source: cached.agentId,
      target: agentId,
      label: `context (${cached.tokens ?? tokens ?? '?'} tok)`,
    });
  }
}

/**
 * Handle context transfer between agents.
 * Call this explicitly when handing off context.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} params
 * @param {string} params.sourceAgent - Source agent ID
 * @param {string} params.targetAgent - Target agent ID
 * @param {string} [params.label] - Description of handoff
 * @param {number} [params.tokens] - Token count being transferred
 */
export function handleContextHandoff(emitter, params) {
  const { sourceAgent, targetAgent, label, tokens } = params;

  emitter.handoff({
    source: sourceAgent,
    target: targetAgent,
    label: label ?? (tokens ? `${tokens} tok` : 'context'),
  });
}

/**
 * Handle model proxy call through Headroom.
 * Emit when Headroom manages/proxies a model invocation.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} params
 * @param {string} params.agentId - Agent making the call
 * @param {string} params.model - Model name/ID
 * @param {number} params.inputTokens - Input token count
 * @param {number} params.outputTokens - Output token count
 */
export function handleModelProxy(emitter, params) {
  const { agentId, model, inputTokens, outputTokens } = params;

  emitter.modelCall({
    parentId: agentId,
    label: model,
    tokens: inputTokens + outputTokens,
  });
}

/**
 * Handle session summary/context save.
 * Call at end of session to emit final context state.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} params
 * @param {string} params.sessionId - Session being summarized
 * @param {number} params.totalTokens - Total tokens in session
 * @param {number} params.savedTokens - Tokens saved via compression
 */
export function handleSessionSummary(emitter, params) {
  const { sessionId, totalTokens, savedTokens } = params;

  emitter.mcpCall({
    parentId: 'orch',
    label: `session-end: ${savedTokens} tok saved`,
  });

  // Emit handoff to orchestrator (session complete)
  emitter.handoff({
    source: sessionId,
    target: 'orch',
    label: `session (${totalTokens} tok)`,
  });
}

/**
 * Get compression statistics.
 * Useful for debugging/monitoring.
 */
export function getCompressionStats() {
  return {
    cachedHashes: compressionCache.size,
    entries: Array.from(compressionCache.entries()).map(([hash, data]) => ({
      hash: hash.slice(0, 8) + '...',
      agentId: data.agentId,
      age: Date.now() - data.timestamp,
      tokens: data.tokens,
    })),
  };
}

// Clean up old cache entries periodically (10 minute TTL)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [hash, data] of compressionCache.entries()) {
    if (data.timestamp < cutoff) {
      compressionCache.delete(hash);
    }
  }
}, 60_000);
