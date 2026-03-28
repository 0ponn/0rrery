/**
 * mcp-emitter.js
 * Topology event emitter — plug into your proxy MCP and IPC MCP.
 *
 * Usage:
 *   import { TopologyEmitter } from './mcp-emitter.js';
 *   const emitter = new TopologyEmitter('ws://localhost:4242');
 *
 *   // Then call the appropriate method wherever your MCP handles each operation:
 *   emitter.agentSpawn({ id, parentId, label });
 *   emitter.modelCall({ id, parentId, label: modelName, tokens: 1800 });
 *   emitter.ipcMessage({ source: agentA, target: agentB, message: 'task data' });
 *   // etc.
 */

import { WebSocket } from 'ws';

// ── Helpers ───────────────────────────────────────────────────────────────────

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ── TopologyEmitter ───────────────────────────────────────────────────────────

export class TopologyEmitter {
  /**
   * @param {string} serverUrl  - WebSocket server URL, e.g. 'ws://localhost:4242'
   * @param {object} [options]
   * @param {number} [options.maxReconnect=8]     - Max reconnection attempts
   * @param {boolean} [options.silent=false]      - Suppress console output
   * @param {string} [options.orchestratorId='orch'] - Root node ID
   */
  constructor(serverUrl, options = {}) {
    this.url             = serverUrl;
    this.maxReconnect    = options.maxReconnect    ?? 8;
    this.silent          = options.silent          ?? false;
    this.orchestratorId  = options.orchestratorId  ?? 'orch';

    this._ws             = null;
    this._queue          = [];   // buffer while disconnected
    this._attempts       = 0;
    this._reconnectTimer = null;
    this._ready          = false;

    this._connect();
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  _connect() {
    try {
      this._ws = new WebSocket(`${this.url}?role=publisher`);
    } catch (err) {
      this._log('error', `Failed to create socket: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      this._log('info', `Connected to topology server at ${this.url}`);
      this._ready    = true;
      this._attempts = 0;
      this._flushQueue();
    });

    this._ws.on('close', () => {
      this._ready = false;
      this._log('warn', 'Disconnected from topology server');
      this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      this._log('error', `Socket error: ${err.message}`);
      // 'close' fires after 'error', reconnect handled there
    });
  }

  _scheduleReconnect() {
    if (this._attempts >= this.maxReconnect) {
      this._log('error', 'Max reconnection attempts reached — topology events will be dropped');
      return;
    }
    const delay = Math.min(1000 * (2 ** this._attempts), 32_000);
    this._log('info', `Reconnecting in ${delay}ms (attempt ${this._attempts + 1})`);
    this._reconnectTimer = setTimeout(() => {
      this._attempts++;
      this._connect();
    }, delay);
  }

  _flushQueue() {
    while (this._queue.length > 0 && this._ready) {
      this._sendRaw(this._queue.shift());
    }
  }

  _sendRaw(payload) {
    try {
      this._ws.send(JSON.stringify(payload));
    } catch (err) {
      this._log('error', `Send failed: ${err.message}`);
    }
  }

  _emit(payload) {
    const event = { timestamp: Date.now(), ...payload };
    if (this._ready) {
      this._sendRaw(event);
    } else {
      this._queue.push(event);  // buffer — flushed on reconnect
    }
  }

  _log(level, msg) {
    if (!this.silent) console[level === 'info' ? 'log' : level](`[TopologyEmitter] ${msg}`);
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  destroy() {
    clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.close();
    }
  }

  // ── Event emitters ────────────────────────────────────────────────────────

  /**
   * Emit when a new sub-agent is spawned.
   * @param {{ id?: string, parentId?: string, label: string }} opts
   */
  agentSpawn({ id, parentId, label }) {
    this._emit({
      type: 'agent_spawn',
      id:       id ?? uid(),
      parentId: parentId ?? this.orchestratorId,
      label,
    });
  }

  /**
   * Emit when an agent completes its task.
   * @param {{ id: string }} opts
   */
  agentDone({ id }) {
    this._emit({ type: 'agent_done', id });
  }

  /**
   * Emit when an agent invokes an LLM.
   * Call this inside your proxy MCP's model call handler.
   * @param {{ id?: string, parentId: string, label: string, tokens?: number }} opts
   */
  modelCall({ id, parentId, label, tokens }) {
    this._emit({
      type:     'model_call',
      id:       id ?? uid(),
      parentId,
      label,
      metadata: { tokens: tokens ?? 0 },
    });
  }

  /**
   * Emit when an agent reads or writes a file.
   * @param {{ id?: string, parentId: string, label: string }} opts
   */
  fileAccess({ id, parentId, label }) {
    this._emit({
      type:     'file_access',
      id:       id ?? uid(),
      parentId,
      label,
    });
  }

  /**
   * Emit when an agent calls an MCP tool.
   * @param {{ id?: string, parentId: string, label: string }} opts
   */
  mcpCall({ id, parentId, label }) {
    this._emit({
      type:     'mcp_call',
      id:       id ?? uid(),
      parentId,
      label,
    });
  }

  /**
   * Emit when an agent makes an external API call.
   * @param {{ id?: string, parentId: string, label: string }} opts
   */
  apiCall({ id, parentId, label }) {
    this._emit({
      type:     'api_call',
      id:       id ?? uid(),
      parentId,
      label,
    });
  }

  /**
   * Emit when your IPC MCP routes a message between agents.
   * Call this inside your IPC MCP's message handler.
   * @param {{ source: string, target: string, message?: string }} opts
   */
  ipcMessage({ source, target, message }) {
    this._emit({
      type: 'ipc_message',
      id:   uid(),
      source,
      target,
      message: message ?? '',
    });
  }

  /**
   * Emit when context/results are handed from one agent/model to another.
   * @param {{ source: string, target: string, label?: string }} opts
   */
  handoff({ source, target, label }) {
    this._emit({
      type: 'handoff',
      id:   uid(),
      source,
      target,
      label: label ?? 'handoff',
    });
  }

  /**
   * Emit when Claude Code requests a user permission.
   * @param {{ id?: string, parentId: string, label: string, action: string }} opts
   */
  permissionRequest({ id, parentId, label, action }) {
    const permId = id ?? uid();
    this._emit({
      type:     'permission_request',
      id:       permId,
      parentId,
      label,
      action,
    });
    return permId; // return so caller can emit permissionResolve with same id
  }

  /**
   * Emit when a permission is approved or denied.
   * @param {{ id: string, status: 'approved' | 'denied' }} opts
   */
  permissionResolve({ id, status }) {
    this._emit({
      type: 'permission_resolve',
      id,
      status,
    });
  }
}
