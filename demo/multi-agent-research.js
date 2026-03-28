#!/usr/bin/env node

/**
 * Multi-Agent Linear Research Simulator
 * Simulates coordinated research across multiple agents with Orrery visualization
 */

import { TopologyEmitter } from '../mcp-emitter.js';
import { createOrreryHooks } from '../instrumentation/index.js';

const LINEAR_PROJECT_ID = 'd33e0a71-ddae-41f8-b331-79112a26480f'; // Texas RFQ - Physical AI Platform
const LINEAR_API_KEY = 'lin_api_zQZt3v9fiFa9mGI4ymDNqkpQfAO2HijZe3eJ7Mkk';
const WS_URL = process.env.ORRERY_WS_URL || 'ws://localhost:4242';
const SESSION_ID = process.env.ORRERY_SESSION_ID || `research-${Date.now().toString(36).slice(-6)}`;

class MultiAgentSimulator {
  constructor(wsUrl) {
    this.emitter = new TopologyEmitter(wsUrl);
    this.hooks = createOrreryHooks({ wsUrl, defaultAgentId: 'claude-orch' });
    this.orchestratorId = 'claude-orch';
  }

  async researchProject(projectId, apiKey) {
    console.log('🚀 Starting multi-agent research simulation...');
    console.log(`📊 Project: ${projectId}`);
    console.log(`🔗 Session: ${SESSION_ID}`);

    // Define simulated agents
    const agents = [
      { id: 'gemini-sim', role: 'issues', label: 'Gemini (Issue Analyzer)' },
      { id: 'cursor-sim', role: 'technical', label: 'Cursor (Technical Specs)' },
      { id: 'codex-sim', role: 'metrics', label: 'Codex (Metrics Analyzer)' }
    ];

    // Emit agent spawn events
    console.log('\n📍 Spawning agents...');
    for (const agent of agents) {
      this.emitter.agentSpawn({
        id: agent.id,
        parentId: this.orchestratorId,
        sessionId: SESSION_ID,
        label: agent.label
      });
      await this.sleep(200);
    }

    // Execute research tasks in parallel
    console.log('\n🔍 Executing research tasks...');
    const results = await Promise.all([
      this.simulateGemini(projectId, apiKey),
      this.simulateCursor(projectId, apiKey),
      this.simulateCodex(projectId, apiKey)
    ]);

    // Emit completion handoffs
    console.log('\n✅ Collecting results...');
    for (const agent of agents) {
      this.emitter.handoff({
        source: agent.id,
        target: this.orchestratorId,
        sessionId: SESSION_ID,
        label: 'Research complete'
      });

      this.emitter.agentDone({
        id: agent.id,
        sessionId: SESSION_ID
      });

      await this.sleep(150);
    }

    // Synthesize report
    const report = this.synthesize(results);

    console.log('\n📋 Research Complete!');
    console.log('━'.repeat(80));
    return report;
  }

  async simulateGemini(projectId, apiKey) {
    const agentId = 'gemini-sim';

    // Emit task assignment
    this.emitter.ipcMessage({
      source: this.orchestratorId,
      target: agentId,
      sessionId: SESSION_ID,
      message: 'Analyze project issues'
    });

    await this.sleep(300);

    // Query Linear for issues
    console.log('  → Gemini: Fetching issues...');
    this.emitter.mcpCall({
      id: `mcp-${Date.now()}`,
      parentId: agentId,
      sessionId: SESSION_ID,
      label: 'linear:list_issues'
    });

    const issues = await this.fetchLinearIssues(projectId, apiKey);
    await this.sleep(800);

    // Analyze issues
    console.log(`  → Gemini: Analyzing ${issues.length} issues...`);
    this.emitter.modelCall({
      id: `model-${Date.now()}`,
      parentId: agentId,
      sessionId: SESSION_ID,
      label: 'claude-sonnet-4.5',
      metadata: { tokens: 2500 }
    });

    await this.sleep(1200);

    const analysis = {
      totalIssues: issues.length,
      byStatus: this.groupBy(issues, 'state.name'),
      byPriority: this.groupBy(issues, 'priority'),
      estimatedHours: this.sumEstimates(issues),
      activeIssues: issues.filter(i => ['started', 'unstarted'].includes(i.state?.name)).length
    };

    // Return results
    this.emitter.ipcMessage({
      source: agentId,
      target: this.orchestratorId,
      sessionId: SESSION_ID,
      message: `Analysis complete: ${issues.length} issues processed`
    });

    console.log(`  ✓ Gemini: Found ${analysis.totalIssues} issues, ${analysis.activeIssues} active`);

    return {
      agentId,
      type: 'issues',
      data: analysis,
      rawIssues: issues
    };
  }

  async simulateCursor(projectId, apiKey) {
    const agentId = 'cursor-sim';

    // Emit task assignment
    this.emitter.ipcMessage({
      source: this.orchestratorId,
      target: agentId,
      sessionId: SESSION_ID,
      message: 'Extract technical specifications'
    });

    await this.sleep(400);

    // Search for technical issues
    console.log('  → Cursor: Searching technical content...');
    this.emitter.mcpCall({
      id: `mcp-${Date.now()}`,
      parentId: agentId,
      sessionId: SESSION_ID,
      label: 'linear:search_issues'
    });

    const issues = await this.fetchLinearIssues(projectId, apiKey);
    const techIssues = issues.filter(i =>
      i.title?.match(/technical|architecture|implementation|design|spec/i) ||
      i.description?.match(/technical|architecture|implementation|design|spec/i)
    );

    await this.sleep(1000);

    // Analyze technical content
    console.log(`  → Cursor: Analyzing ${techIssues.length} technical issues...`);
    this.emitter.modelCall({
      id: `model-${Date.now()}`,
      parentId: agentId,
      sessionId: SESSION_ID,
      label: 'claude-sonnet-4.5',
      metadata: { tokens: 3200 }
    });

    await this.sleep(1500);

    const analysis = {
      technicalIssues: techIssues.length,
      architectureDecisions: techIssues.filter(i => i.title?.match(/architecture|design/i)).length,
      implementationTasks: techIssues.filter(i => i.title?.match(/implement|build|create/i)).length,
      techDebt: techIssues.filter(i => i.title?.match(/refactor|tech debt|cleanup/i)).length
    };

    // Return results
    this.emitter.ipcMessage({
      source: agentId,
      target: this.orchestratorId,
      sessionId: SESSION_ID,
      message: `Technical analysis complete: ${techIssues.length} items`
    });

    console.log(`  ✓ Cursor: ${analysis.technicalIssues} technical issues, ${analysis.architectureDecisions} architecture decisions`);

    return {
      agentId,
      type: 'technical',
      data: analysis,
      rawIssues: techIssues
    };
  }

  async simulateCodex(projectId, apiKey) {
    const agentId = 'codex-sim';

    // Emit task assignment
    this.emitter.ipcMessage({
      source: this.orchestratorId,
      target: agentId,
      sessionId: SESSION_ID,
      message: 'Calculate project metrics'
    });

    await this.sleep(350);

    // Fetch project details
    console.log('  → Codex: Fetching project metrics...');
    this.emitter.mcpCall({
      id: `mcp-${Date.now()}`,
      parentId: agentId,
      sessionId: SESSION_ID,
      label: 'linear:get_project'
    });

    const project = await this.fetchLinearProject(projectId, apiKey);
    const issues = await this.fetchLinearIssues(projectId, apiKey);

    await this.sleep(900);

    // Calculate metrics
    console.log('  → Codex: Calculating velocity and timeline...');
    this.emitter.modelCall({
      id: `model-${Date.now()}`,
      parentId: agentId,
      sessionId: SESSION_ID,
      label: 'claude-sonnet-4.5',
      metadata: { tokens: 1800 }
    });

    await this.sleep(1100);

    const completed = issues.filter(i => i.state?.name === 'completed' || i.state?.name === 'done').length;
    const total = issues.length;
    const completionRate = total > 0 ? (completed / total) * 100 : 0;

    const metrics = {
      progress: project.progress || 0,
      completionRate: completionRate.toFixed(1),
      totalIssues: total,
      completedIssues: completed,
      velocity: this.estimateVelocity(issues),
      timelineHealth: completionRate > 75 ? 'On Track' : completionRate > 50 ? 'At Risk' : 'Behind'
    };

    // Return results
    this.emitter.ipcMessage({
      source: agentId,
      target: this.orchestratorId,
      sessionId: SESSION_ID,
      message: `Metrics complete: ${completionRate.toFixed(0)}% done`
    });

    console.log(`  ✓ Codex: ${metrics.completionRate}% complete, ${metrics.timelineHealth}`);

    return {
      agentId,
      type: 'metrics',
      data: metrics,
      rawProject: project
    };
  }

  synthesize(results) {
    const issueData = results.find(r => r.type === 'issues')?.data;
    const techData = results.find(r => r.type === 'technical')?.data;
    const metricsData = results.find(r => r.type === 'metrics')?.data;

    const report = {
      project: {
        name: 'Texas RFQ - Physical AI Platform',
        id: LINEAR_PROJECT_ID,
        url: `https://linear.app/0pon/project/texas-rfq-physical-ai-platform-${LINEAR_PROJECT_ID}`,
        workspace: '0pon'
      },

      summary: {
        totalIssues: issueData?.totalIssues || 0,
        activeIssues: issueData?.activeIssues || 0,
        completionRate: metricsData?.completionRate || '0',
        timelineHealth: metricsData?.timelineHealth || 'Unknown',
        technicalIssues: techData?.technicalIssues || 0
      },

      issueAnalysis: issueData,
      technicalAnalysis: techData,
      metricsAnalysis: metricsData,

      keyFindings: [
        `Project has ${issueData?.totalIssues || 0} total issues with ${issueData?.activeIssues || 0} currently active`,
        `${metricsData?.completionRate || 0}% completion rate - status: ${metricsData?.timelineHealth || 'Unknown'}`,
        `${techData?.technicalIssues || 0} technical issues identified`,
        `${techData?.architectureDecisions || 0} architecture decisions documented`,
        issueData?.estimatedHours ? `Estimated ${issueData.estimatedHours} hours remaining` : null
      ].filter(Boolean),

      metadata: {
        sessionId: SESSION_ID,
        participants: results.map(r => r.agentId),
        timestamp: new Date().toISOString()
      }
    };

    return report;
  }

  async fetchLinearIssues(projectId, apiKey) {
    const query = `
      query GetProjectIssues($projectId: String!) {
        project(id: $projectId) {
          issues {
            nodes {
              id
              title
              description
              priority
              estimate
              state {
                name
                type
              }
              createdAt
              completedAt
            }
          }
        }
      }
    `;

    try {
      const response = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': apiKey
        },
        body: JSON.stringify({
          query,
          variables: { projectId }
        })
      });

      const data = await response.json();
      return data.data?.project?.issues?.nodes || [];
    } catch (error) {
      console.error('Error fetching Linear issues:', error.message);
      return [];
    }
  }

  async fetchLinearProject(projectId, apiKey) {
    const query = `
      query GetProject($projectId: String!) {
        project(id: $projectId) {
          id
          name
          description
          state
          progress
          targetDate
          startDate
        }
      }
    `;

    try {
      const response = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': apiKey
        },
        body: JSON.stringify({
          query,
          variables: { projectId }
        })
      });

      const data = await response.json();
      return data.data?.project || {};
    } catch (error) {
      console.error('Error fetching Linear project:', error.message);
      return {};
    }
  }

  groupBy(items, path) {
    const result = {};
    items.forEach(item => {
      const value = path.split('.').reduce((obj, key) => obj?.[key], item) || 'unknown';
      result[value] = (result[value] || 0) + 1;
    });
    return result;
  }

  sumEstimates(issues) {
    return issues.reduce((sum, issue) => sum + (issue.estimate || 0), 0);
  }

  estimateVelocity(issues) {
    const completed = issues.filter(i => i.completedAt);
    if (completed.length === 0) return 0;

    // Calculate average completion time
    const now = Date.now();
    const avgAge = completed.reduce((sum, i) => {
      const created = new Date(i.createdAt).getTime();
      const done = new Date(i.completedAt).getTime();
      return sum + (done - created);
    }, 0) / completed.length;

    // Issues per week
    const avgDays = avgAge / (1000 * 60 * 60 * 24);
    const avgWeeks = avgDays / 7;
    return (completed.length / avgWeeks).toFixed(1);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  const simulator = new MultiAgentSimulator(WS_URL);

  try {
    const report = await simulator.researchProject(LINEAR_PROJECT_ID, LINEAR_API_KEY);

    // Display report
    console.log('\n' + '═'.repeat(80));
    console.log('📊 RESEARCH REPORT: Texas RFQ - Physical AI Platform');
    console.log('═'.repeat(80));
    console.log('\n🎯 Summary:');
    Object.entries(report.summary).forEach(([key, value]) => {
      console.log(`  • ${key}: ${value}`);
    });

    console.log('\n💡 Key Findings:');
    report.keyFindings.forEach((finding, i) => {
      console.log(`  ${i + 1}. ${finding}`);
    });

    console.log('\n📈 Issue Breakdown:');
    if (report.issueAnalysis?.byStatus) {
      Object.entries(report.issueAnalysis.byStatus).forEach(([status, count]) => {
        console.log(`  • ${status}: ${count}`);
      });
    }

    if (report.issueAnalysis?.byPriority) {
      console.log('\n⚡ Priority Distribution:');
      Object.entries(report.issueAnalysis.byPriority).forEach(([priority, count]) => {
        console.log(`  • Priority ${priority}: ${count}`);
      });
    }

    console.log('\n' + '═'.repeat(80));
    console.log(`\n✅ Report generated by ${report.metadata.participants.length} agents`);
    console.log(`🔗 Session ID: ${report.metadata.sessionId}`);
    console.log(`📅 Timestamp: ${report.metadata.timestamp}`);
    console.log('\n🎨 View visualization at: http://localhost:3000');
    console.log('═'.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Error during research:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
