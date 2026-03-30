/**
 * theme.js
 * Shared color palette, node styles, icons, and type mappings for the Orrery dashboard.
 */

export const C = {
  bg: '#1a1d23', panel: '#21252b', border: '#3e4451',
  teal: '#56b6c2', amber: '#d19a66', purple: '#c678dd',
  green: '#98c379', red: '#e06c75', blue: '#61afef',
  magenta: '#c678dd', yellow: '#e5c07b', coral: '#e06c75',
  white: '#abb2bf', dim: '#282c34', dimText: '#5c6370',
};

export const NSTYLE = {
  orchestrator: { color: C.teal,    r: 22 },
  agent:        { color: C.blue,    r: 17 },
  model:        { color: C.purple,  r: 14 },
  file:         { color: C.amber,   r: 11 },
  mcp:          { color: C.green,   r: 13 },
  api:          { color: C.coral,   r: 12 },
  permission:   { color: C.yellow,  r: 13 },
};

export const NICON = {
  orchestrator: '\u2B21', agent: '\u25C8', model: '\u25C9',
  file: '\u25A3', mcp: '\u25C6', api: '\u2295', permission: '\u26A0',
};

// Maps incoming event type -> D3 node type
export const TYPE_MAP = {
  agent_spawn:        'agent',
  model_call:         'model',
  file_access:        'file',
  mcp_call:           'mcp',
  api_call:           'api',
  permission_request: 'permission',
};

export const STATUS_COLOR = {
  connected:    C.green,
  connecting:   C.amber,
  disconnected: C.red,
  failed:       C.red,
  'no-url':     C.dimText,
};

export const EVTCOL = {
  agent_spawn: C.blue, model_call: C.purple, file_access: C.amber,
  mcp_call: C.green, api_call: C.coral, permission: C.yellow,
  ipc: C.magenta, handoff: C.teal, system: C.teal, agent_done: C.dimText,
};

export const AGENT_COLORS = {
  claude: '#c678dd',  // purple
  gemini: '#61afef',  // blue
  codex: '#98c379',   // green
  cursor: '#56b6c2',  // teal
  unknown: '#abb2bf', // white
};

// TYPE_COLORS used by TimelineView and MetricsView (superset of EVTCOL event types)
export const TYPE_COLORS = {
  agent_spawn: C.blue,
  model_call: C.purple,
  file_access: C.amber,
  mcp_call: C.green,
  api_call: C.coral,
  permission_request: C.yellow,
  ipc_message: C.magenta,
  handoff: C.teal,
};
