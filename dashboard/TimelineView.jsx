/**
 * TimelineView.jsx
 * Timeline/Gantt visualization for agent workflow execution.
 * Shows temporal relationships, parallelism, and operation duration.
 */

import { useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { C, TYPE_COLORS } from './theme.js';

export function TimelineView({ events, nodes, width = 900, height = 500 }) {
  const svgRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    if (events.length === 0) {
      // Show empty state
      svg.append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('font-size', 14)
        .attr('fill', C.dimText)
        .text('No events yet — run demo or start using Claude Code');
      return;
    }

    // Build timeline data from events
    const timelineEvents = events
      .filter(e => e.timestamp && e.type !== 'permission_resolve' && e.type !== 'agent_done' && e.type !== 'system')
      .map(e => ({
        ...e,
        agent: e.parentId || e.source || 'system',
        start: e.timestamp,
        // Estimate duration based on type
        duration: e.type === 'model_call' ? Math.max(500, (e.metadata?.tokens || 1000) * 0.5) :
                  e.type === 'agent_spawn' ? 200 :
                  e.type === 'file_access' ? 100 :
                  e.type === 'api_call' ? 500 :
                  e.type === 'mcp_call' ? 150 :
                  e.type === 'permission_request' ? 100 : 50,
      }))
      .sort((a, b) => a.start - b.start);

    if (timelineEvents.length === 0) {
      svg.append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('font-size', 14)
        .attr('fill', C.dimText)
        .text('No timeline events — try running the demo');
      return;
    }

    // Group by agent to create swimlanes
    const agentMap = new Map();
    timelineEvents.forEach(e => {
      if (!agentMap.has(e.agent)) {
        agentMap.set(e.agent, []);
      }
      agentMap.get(e.agent).push(e);
    });

    const agents = Array.from(agentMap.keys());
    const laneHeight = 60;
    const headerWidth = 150;
    const margin = { top: 40, right: 20, bottom: 40, left: headerWidth };

    const minTime = d3.min(timelineEvents, e => e.start);
    const maxTime = d3.max(timelineEvents, e => e.start + e.duration);
    const timeRange = maxTime - minTime;

    const xScale = d3.scaleLinear()
      .domain([minTime, maxTime + timeRange * 0.05])
      .range([margin.left, width - margin.right]);

    const yScale = d3.scaleBand()
      .domain(agents)
      .range([margin.top, margin.top + agents.length * laneHeight])
      .padding(0.15);

    // Background
    svg.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', C.bg);

    const g = svg.append('g');

    // Grid lines
    const timeAxis = d3.axisBottom(xScale)
      .ticks(8)
      .tickFormat(d => {
        const elapsed = (d - minTime) / 1000;
        return `${elapsed.toFixed(1)}s`;
      });

    g.append('g')
      .attr('transform', `translate(0,${margin.top - 10})`)
      .call(timeAxis)
      .attr('color', C.dimText)
      .selectAll('text')
      .attr('font-size', 10)
      .attr('fill', C.dimText);

    // Vertical grid
    xScale.ticks(8).forEach(tick => {
      g.append('line')
        .attr('x1', xScale(tick))
        .attr('x2', xScale(tick))
        .attr('y1', margin.top)
        .attr('y2', margin.top + agents.length * laneHeight)
        .attr('stroke', C.border)
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2,2')
        .attr('opacity', 0.3);
    });

    // Swimlanes
    agents.forEach((agent, i) => {
      const y = yScale(agent);

      // Lane background
      g.append('rect')
        .attr('x', 0)
        .attr('y', y)
        .attr('width', width)
        .attr('height', yScale.bandwidth())
        .attr('fill', i % 2 === 0 ? C.dim : 'transparent')
        .attr('opacity', 0.3);

      // Lane label
      g.append('text')
        .attr('x', 10)
        .attr('y', y + yScale.bandwidth() / 2)
        .attr('dominant-baseline', 'middle')
        .attr('font-size', 11)
        .attr('font-weight', 600)
        .attr('fill', C.white)
        .text(agent);

      // Separator line
      g.append('line')
        .attr('x1', headerWidth)
        .attr('x2', headerWidth)
        .attr('y1', y)
        .attr('y2', y + yScale.bandwidth())
        .attr('stroke', C.border)
        .attr('stroke-width', 1);
    });

    // Events as bars
    const bars = g.selectAll('.event-bar')
      .data(timelineEvents)
      .enter()
      .append('g')
      .attr('class', 'event-bar');

    bars.append('rect')
      .attr('x', d => xScale(d.start))
      .attr('y', d => yScale(d.agent) + 8)
      .attr('width', d => Math.max(3, xScale(d.start + d.duration) - xScale(d.start)))
      .attr('height', yScale.bandwidth() - 16)
      .attr('fill', d => TYPE_COLORS[d.type] || C.blue)
      .attr('rx', 3)
      .attr('opacity', 0.85)
      .attr('stroke', d => TYPE_COLORS[d.type] || C.blue)
      .attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('mouseenter', function(event, d) {
        d3.select(this)
          .attr('opacity', 1)
          .attr('stroke-width', 2);

        // Show tooltip
        const tooltip = g.append('g').attr('class', 'tooltip');
        const text = tooltip.append('text')
          .attr('x', xScale(d.start))
          .attr('y', yScale(d.agent) - 10)
          .attr('font-size', 10)
          .attr('fill', C.white)
          .attr('font-weight', 500)
          .text(`${d.label || d.type} (${(d.duration / 1000).toFixed(2)}s)`);

        const bbox = text.node().getBBox();
        tooltip.insert('rect', 'text')
          .attr('x', bbox.x - 4)
          .attr('y', bbox.y - 2)
          .attr('width', bbox.width + 8)
          .attr('height', bbox.height + 4)
          .attr('fill', C.panel)
          .attr('rx', 3)
          .attr('stroke', C.border);
      })
      .on('mouseleave', function() {
        d3.select(this)
          .attr('opacity', 0.85)
          .attr('stroke-width', 1.5);
        g.selectAll('.tooltip').remove();
      });

    // Event labels (for longer events)
    bars.filter(d => (xScale(d.start + d.duration) - xScale(d.start)) > 40)
      .append('text')
      .attr('x', d => xScale(d.start) + 6)
      .attr('y', d => yScale(d.agent) + yScale.bandwidth() / 2)
      .attr('dominant-baseline', 'middle')
      .attr('font-size', 9)
      .attr('fill', C.bg)
      .attr('font-weight', 600)
      .attr('pointer-events', 'none')
      .text(d => {
        const label = d.label || d.type;
        const maxWidth = xScale(d.start + d.duration) - xScale(d.start) - 12;
        return label.length * 6 > maxWidth ? label.slice(0, Math.floor(maxWidth / 6)) + '...' : label;
      });

    // Handoff arrows
    const handoffs = timelineEvents.filter(e => e.type === 'handoff' || e.type === 'ipc_message');
    handoffs.forEach(h => {
      const fromY = yScale(h.source) + yScale.bandwidth() / 2;
      const toY = yScale(h.target) + yScale.bandwidth() / 2;
      const x = xScale(h.start);

      if (fromY !== undefined && toY !== undefined) {
        g.append('line')
          .attr('x1', x)
          .attr('y1', fromY)
          .attr('x2', x)
          .attr('y2', toY)
          .attr('stroke', TYPE_COLORS[h.type])
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '4,2')
          .attr('opacity', 0.6)
          .attr('marker-end', 'url(#arrow)');
      }
    });

    // Arrow marker
    svg.append('defs').append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', 5)
      .attr('refY', 5)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto-start-reverse')
      .append('path')
      .attr('d', 'M 0 0 L 10 5 L 0 10 z')
      .attr('fill', C.teal);

  }, [events, nodes, width, height]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'auto', background: C.bg }}>
      <svg ref={svgRef} width={width} height={Math.max(500, events.length * 2)} />
    </div>
  );
}
