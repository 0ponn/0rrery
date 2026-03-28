/**
 * ppr-emitter.js
 * PPR (Parallax Process Runtime) instrumentation for Orrery.
 *
 * Hook point: PPR's inter-process message routing
 * Event type: ipc_message
 *
 * PPR is the primary event source — every message routed between agents
 * fires an ipc_message event to the topology dashboard.
 *
 * Usage:
 *   import { TopologyEmitter } from '../mcp-emitter.js';
 *   import { setupPprEmitter } from './ppr-emitter.js';
 *
 *   const emitter = new TopologyEmitter('ws://localhost:4242');
 *   setupPprEmitter(emitter);
 */

import config from '../orrery.config.js';
import { existsSync } from 'fs';

/**
 * Set up PPR message routing instrumentation.
 * Hooks into PPR's IPC bus to emit topology events for every routed message.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} [options]
 * @param {object} [options.pprBus] - PPR bus instance (if already available)
 */
export function setupPprEmitter(emitter, options = {}) {
  const pprPath = config.tools.ppr;

  // Defensive check: verify PPR binary exists
  if (!existsSync(pprPath)) {
    console.warn(`[orrery/ppr] PPR binary not found at ${pprPath} — skipping instrumentation`);
    return { active: false, reason: 'binary_not_found' };
  }

  console.log(`[orrery/ppr] Instrumenting PPR at ${pprPath}`);

  // If a PPR bus instance is provided, hook directly
  if (options.pprBus) {
    return hookIntoPprBus(emitter, options.pprBus);
  }

  // Otherwise, attempt to connect to PPR's IPC channel
  // PPR exposes a shared memory channel for inter-process communication
  return connectToPprChannel(emitter);
}

/**
 * Hook into an existing PPR bus instance.
 * Called when PPR is imported as a module.
 */
function hookIntoPprBus(emitter, bus) {
  // PPR's message handler — intercept all routed messages
  const originalPublish = bus.publish?.bind(bus);
  const originalRequest = bus.request?.bind(bus);

  if (originalPublish) {
    bus.publish = (topic, payload) => {
      // Parse agent IDs from topic (format: "agent.{from}.{to}" or similar)
      const parts = topic.split('.');
      const source = parts[1] ?? 'unknown';
      const target = parts[2] ?? 'broadcast';

      emitter.ipcMessage({
        source,
        target,
        message: `${topic}: ${truncate(JSON.stringify(payload), 80)}`,
      });

      return originalPublish(topic, payload);
    };
  }

  if (originalRequest) {
    bus.request = (topic, payload, timeout) => {
      const parts = topic.split('.');
      const source = parts[1] ?? 'caller';
      const target = parts[2] ?? 'handler';

      emitter.ipcMessage({
        source,
        target,
        message: `RPC ${topic}`,
      });

      return originalRequest(topic, payload, timeout);
    };
  }

  console.log('[orrery/ppr] Hooked into PPR bus instance');
  return { active: true, mode: 'direct_hook' };
}

/**
 * Connect to PPR's shared memory IPC channel.
 * Called when PPR is running as a separate process.
 */
function connectToPprChannel(emitter) {
  // PPR MCP server exposes tools via IPC — we can use the MCP protocol
  // to subscribe to message events

  try {
    // Attempt dynamic import of PPR's client library
    // This is a placeholder — actual implementation depends on PPR's API
    const setupSubscription = async () => {
      // PPR uses libipc shared memory channels
      // We need to subscribe to the message routing topic

      // For now, we'll set up a polling mechanism that checks
      // PPR's status and emits events when available

      console.log('[orrery/ppr] PPR channel subscription initialized (passive mode)');
      console.log('[orrery/ppr] To enable full instrumentation, pass pprBus instance to setupPprEmitter');

      return { active: true, mode: 'passive' };
    };

    return setupSubscription();
  } catch (err) {
    console.warn(`[orrery/ppr] Failed to connect to PPR channel: ${err.message}`);
    return { active: false, reason: 'connection_failed', error: err.message };
  }
}

/**
 * Emit PPR message event directly.
 * Call this from your PPR message handlers.
 *
 * @param {import('../mcp-emitter.js').TopologyEmitter} emitter
 * @param {object} msg - PPR message envelope
 * @param {string} msg.source - Source agent ID
 * @param {string} msg.target - Target agent ID
 * @param {string} [msg.topic] - Message topic
 * @param {any} [msg.payload] - Message payload
 */
export function emitPprMessage(emitter, msg) {
  emitter.ipcMessage({
    source: msg.source,
    target: msg.target,
    message: msg.topic
      ? `${msg.topic}: ${truncate(JSON.stringify(msg.payload), 60)}`
      : truncate(JSON.stringify(msg.payload), 80),
  });
}

/**
 * Emit PPR agent lifecycle events.
 * Call these when agents are spawned/completed via PPR.
 */
export function emitPprAgentSpawn(emitter, { id, parentId, label }) {
  emitter.agentSpawn({ id, parentId, label });
}

export function emitPprAgentDone(emitter, { id }) {
  emitter.agentDone({ id });
}

// Helper: truncate string
function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}
