/**
 * useTopologySocket.js
 * React hook — manages WebSocket lifecycle, buffering, and backpressure.
 * Decoupled from D3. Only job: network + batching.
 *
 * Usage:
 *   import { useTopologySocket } from './useTopologySocket.js';
 *   const { status } = useTopologySocket('ws://localhost:4242', handleBatch);
 */

import { useEffect, useRef, useState, useCallback } from 'react';

const MAX_RECONNECT = 6;

export function useTopologySocket(url, onEventBatch) {
  const [status, setStatus]   = useState('disconnected');
  const wsRef                 = useRef(null);
  const bufferRef             = useRef([]);
  const reconnectRef          = useRef(null);
  const attemptsRef           = useRef(0);
  // Stable ref — flush interval never needs to re-register when callback identity changes
  const onEventBatchRef       = useRef(onEventBatch);

  useEffect(() => { onEventBatchRef.current = onEventBatch; }, [onEventBatch]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Placeholder guard — don't attempt connection to default stub URL
    if (!url || url.includes('your-proxy-mcp')) {
      setStatus('no-url');
      return;
    }

    setStatus('connecting');
    // Connect as subscriber (read-only — dashboard only receives events)
    const ws = new WebSocket(`${url}?role=subscriber`);

    ws.onopen = () => {
      setStatus('connected');
      attemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        // Support single event or array batch from server
        bufferRef.current.push(...(Array.isArray(payload) ? payload : [payload]));
      } catch (err) {
        console.error('[TopologySocket] Parse error:', err);
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      if (attemptsRef.current < MAX_RECONNECT) {
        // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 32s
        const delay = Math.min(1000 * (2 ** attemptsRef.current), 32_000);
        reconnectRef.current = setTimeout(() => {
          attemptsRef.current += 1;
          connect();
        }, delay);
      } else {
        setStatus('failed');
        console.error('[TopologySocket] Max reconnection attempts reached.');
      }
    };

    ws.onerror = (err) => {
      console.error('[TopologySocket] Error:', err);
      ws.close(); // triggers onclose → reconnect logic
    };

    wsRef.current = ws;
  }, [url]);

  // Flush buffer every 50ms — prevents D3/React collision under high event volume
  useEffect(() => {
    const interval = setInterval(() => {
      if (bufferRef.current.length === 0) return;
      const batch = [...bufferRef.current];
      bufferRef.current = [];
      onEventBatchRef.current(batch);
    }, 50);
    return () => clearInterval(interval);
  }, []); // intentionally empty — onEventBatchRef stays fresh via ref

  // Mount / unmount lifecycle
  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional teardown
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { status };
}
