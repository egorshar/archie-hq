/**
 * Research MCP Tools
 *
 * Provides a `web_research` MCP tool that spawns a multi-agent research pipeline
 * (lead agent → parallel researchers → report writer) using Claude Agent SDK.
 * Returns synthesized findings as markdown.
 */

import crypto from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinition, HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadPrompt } from '../utils/prompt-loader.js';
import { processAgentEventForLogging, logger } from '../system/logger.js';
import { appendAgentFinding } from '../system/task-manager.js';

export interface ResearchToolCallbacks {
  getResearchesDir: () => string;  // returns <task>/researches
  getCallerAgentId: () => string;  // which agent invoked the tool
}

export function createWebResearchTool(callbacks: ResearchToolCallbacks) {
  return tool(
    'web_research',
    'Research a topic using web search. Spawns parallel researchers to gather data, then synthesizes findings into a structured report. Returns the report as markdown. Use for any task requiring up-to-date information from the internet.',
    {
      topic: z.string().describe('The topic to research'),
      context: z.string().optional().describe('Optional context about why this research is needed and what to focus on'),
    },
    async (args) => {
      // Generate UUID for this research session
      const researchId = crypto.randomUUID();
      const researchDir = join(callbacks.getResearchesDir(), researchId);

      // Ensure research directories exist
      await mkdir(join(researchDir, 'notes'), { recursive: true });

      // Write request manifest for traceability
      const request = {
        id: researchId,
        topic: args.topic,
        context: args.context || null,
        caller: callbacks.getCallerAgentId(),
        created_at: new Date().toISOString(),
      };
      await writeFile(join(researchDir, 'request.json'), JSON.stringify(request, null, 2));

      // Load prompts
      const leadPrompt = await loadPrompt('research/lead-agent', {});
      const researcherPrompt = await loadPrompt('research/researcher', {});
      const reportWriterPrompt = await loadPrompt('research/report-writer', {});

      // Build the research query with context
      const userPrompt = args.context
        ? `Research topic: ${args.topic}\n\nContext: ${args.context}`
        : `Research topic: ${args.topic}`;

      // Define subagents
      const agents: Record<string, AgentDefinition> = {
        researcher: {
          description: 'Web search researcher that gathers data-rich findings on specific subtopics.',
          tools: ['WebSearch', 'WebFetch', 'Write'],
          prompt: researcherPrompt,
          model: 'haiku',
        },
        'report-writer': {
          description: 'Synthesizes research notes into a structured markdown report.',
          tools: ['Glob', 'Read', 'Write'],
          prompt: reportWriterPrompt,
          model: 'haiku',
        },
      };

      const agentName = `research:${researchId.slice(0, 8)}`;
      logger.agent(agentName, `Starting research`);
      logger.agent(agentName, `  Topic: ${args.topic}`);
      if (args.context) {
        logger.agent(agentName, `  Context: ${args.context}`);
      }

      // Run pipeline with error handling — return partial results on failure
      try {
        const agentQuery = query({
          prompt: userPrompt,
          options: {
            model: 'sonnet',
            systemPrompt: leadPrompt,
            cwd: researchDir,
            permissionMode: 'dontAsk',
            allowedTools: ['Task', 'WebSearch', 'WebFetch', 'Write', 'Glob', 'Read'],
            agents,
            maxTurns: 50,
            executable: 'node',
            pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || 'claude',
            env: {
              NODE_ENV: process.env.NODE_ENV || 'development',
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
              PATH: process.env.PATH,
            },
            stderr: (data: string) => {
              logger.debug(agentName, `stderr: ${data.trim()}`);
            },
          },
        });

        // Consume events — log to console same as other agents
        for await (const event of agentQuery) {
          processAgentEventForLogging(event, agentName, [researchDir]);
        }

        logger.agent(agentName, 'Research pipeline complete');
      } catch (error) {
        logger.error(agentName, 'Research pipeline failed', error);
        // Fall through to return whatever partial results exist
      }

      // Read the final report
      const reportPath = join(researchDir, 'report.md');
      const shortId = researchId.slice(0, 8);
      if (existsSync(reportPath)) {
        const report = await readFile(reportPath, 'utf-8');
        return {
          content: [
            { type: 'text' as const, text: report },
            { type: 'text' as const, text: `<!-- research_id:${shortId} -->` },
          ],
        };
      }

      // No report — try to return raw notes as fallback
      const notesDir = join(researchDir, 'notes');
      if (existsSync(notesDir)) {
        const noteFiles = await readdir(notesDir);
        if (noteFiles.length > 0) {
          const notes: string[] = [];
          for (const file of noteFiles) {
            const content = await readFile(join(notesDir, file), 'utf-8');
            notes.push(`## ${file.replace('.md', '')}\n\n${content}`);
          }
          return {
            content: [{ type: 'text' as const, text: `# Research Notes (raw — report generation failed)\n\nResearch ID: ${researchId}\n\n${notes.join('\n\n---\n\n')}` }],
          };
        }
      }

      return {
        content: [{ type: 'text' as const, text: `Research failed to produce results. Research ID: ${researchId} (check researches/${researchId}/ for diagnostics)` }],
      };
    }
  );
}

export function createResearchMcpServer(callbacks: ResearchToolCallbacks) {
  return createSdkMcpServer({
    name: 'research-tools',
    version: '1.0.0',
    tools: [createWebResearchTool(callbacks)],
  });
}

/**
 * PostToolUse hook that saves research reports to shared/ and logs to knowledge.log.
 * Runs deterministically after every successful web_research call — no LLM involved.
 */
export function createResearchPostToolHook(opts: {
  getSharedDir: () => string;
  getTaskId: () => string;
  getAgentId: () => string;
}): HookCallbackMatcher {
  return {
    matcher: 'mcp__research-tools__web_research',
    hooks: [
      async (input) => {
        const hookInput = input as any;
        const topic = hookInput.tool_input?.topic || 'unknown';
        const response = hookInput.tool_response;

        // Extract report text and research ID from MCP response content array
        let reportText: string | null = null;
        let researchId: string | null = null;
        if (Array.isArray(response)) {
          for (const block of response) {
            if (block.type !== 'text') continue;
            const idMatch = block.text?.match(/<!-- research_id:(\w+) -->/);
            if (idMatch) {
              researchId = idMatch[1];
            } else if (block.text && !reportText) {
              reportText = block.text;
            }
          }
        } else if (typeof response === 'string') {
          reportText = response;
        }

        if (!reportText || reportText.includes('Research failed to produce results')) {
          return { continue: true } as HookJSONOutput;
        }

        // Use research ID from pipeline, fall back to timestamp
        const fileId = researchId || new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        const filename = `research-${fileId}.md`;

        // Write to shared/researches/
        const researchesDir = join(opts.getSharedDir(), 'researches');
        await mkdir(researchesDir, { recursive: true });
        await writeFile(join(researchesDir, filename), reportText);

        // Log to knowledge.log
        await appendAgentFinding(
          opts.getTaskId(),
          opts.getAgentId(),
          `Research completed: "${topic}" — report saved as researches/${filename}`,
          'discovery'
        );

        logger.agent(opts.getAgentId(), `Research report saved to shared/researches/${filename}`);

        return { continue: true } as HookJSONOutput;
      },
    ],
  };
}
