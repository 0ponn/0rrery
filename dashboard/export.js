/**
 * export.js
 * Session export utilities for CSV and Markdown formats.
 */

export function exportCSV(session) {
  const headers = ['timestamp', 'type', 'id', 'sessionId', 'parentId', 'label', 'tokens'];
  const rows = session.events.map(e => [
    e.timestamp || '',
    e.type || '',
    e.id || '',
    e.sessionId || '',
    e.parentId || '',
    (e.label || '').replace(/,/g, ';'),
    e.metadata?.tokens || '',
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  download(csv, `orrery-${session.sessionId}.csv`, 'text/csv');
}

export function exportMarkdown(session) {
  const { events, metadata, sessionId } = session;
  const agents = events.filter(e => e.type === 'agent_spawn');
  const models = events.filter(e => e.type === 'model_call');
  const totalTokens = models.reduce((sum, e) => sum + (e.metadata?.tokens || 0), 0);
  const duration = metadata?.duration ? (metadata.duration / 1000).toFixed(1) : 'N/A';

  const md = `# Orrery Session: ${sessionId}

## Summary
- **Events:** ${events.length}
- **Duration:** ${duration}s
- **Agents:** ${agents.length}
- **Model Calls:** ${models.length}
- **Total Tokens:** ${totalTokens.toLocaleString()}

## Agents
${agents.map(a => `- **${a.label || a.id}** (parent: ${a.parentId || 'root'})`).join('\n') || '_None_'}

## Event Timeline
| Time | Type | Label |
|------|------|-------|
${events.map(e => {
  const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
  return `| ${time} | ${e.type} | ${e.label || e.id || ''} |`;
}).join('\n')}
`;

  download(md, `orrery-${sessionId}.md`, 'text/markdown');
}

function download(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
