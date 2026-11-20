/**
 * System prompt generation.
 *
 * Builds a dynamic system prompt that includes:
 *  - Role and behavioural instructions
 *  - Working directory and project structure
 *  - Tool descriptions (auto-generated from tool schemas)
 *  - Skills catalog (loaded progressively from skill directories)
 *  - AGENTS.md content (custom instructions for the agent)
 *  - Guidelines for file operations, TODO tracking, etc.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getAllTools } from './tools/index.js';
import { buildSkillsCatalogSection, initializeSkillsSupport } from './skills.js';
import { getActiveRuntimeConfigPath } from './runtime-config.js';

/**
 * Load AGENTS.md content from cwd and parent directories.
 *
 * AGENTS.md (https://agents.md/) is a simple, open format for guiding coding agents.
 * It's like a README for agents — a dedicated place to give AI coding tools the
 * context they need to work on a project.
 *
 * The lookup is hierarchical:
 *  - Checks cwd, then parent directories up to the filesystem root
 *  - First AGENTS.md found wins
 *  - Returns null if no AGENTS.md is found
 */
async function loadAgentsMd(): Promise<{ content: string; path: string } | null> {
  let currentDir = path.resolve('.');

  while (true) {
    const agentsPath = path.join(currentDir, 'AGENTS.md');
    try {
      await fs.access(agentsPath);
      const content = await fs.readFile(agentsPath, 'utf-8');
      return { content, path: agentsPath };
    } catch {
      // File doesn't exist here — check parent
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // Reached filesystem root
    currentDir = parentDir;
  }

  return null;
}

/** Build a filtered directory tree (depth 3, excludes noise). */
async function buildDirectoryTree(dirPath = '.', depth = 0, maxDepth = 3): Promise<string> {
  if (depth > maxDepth) return '';

  const indent = '  '.repeat(depth);
  let tree = '';

  try {
    const fullPath = path.resolve(dirPath);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });

    const filtered = entries.filter((e) => {
      const n = e.name;
      return !n.startsWith('.') && !['node_modules', 'dist', 'build', 'coverage', '__pycache__', '.git'].includes(n) && !n.endsWith('.log');
    });

    for (const entry of filtered.slice(0, 20)) {
      if (entry.isDirectory()) {
        tree += `${indent}${entry.name}/\n`;
        tree += await buildDirectoryTree(path.join(dirPath, entry.name), depth + 1, maxDepth);
      } else {
        tree += `${indent}${entry.name}\n`;
      }
    }

    if (filtered.length > 20) {
      tree += `${indent}... (${filtered.length - 20} more)\n`;
    }
  } catch {
    // Can't read directory — skip
  }

  return tree;
}

/** Compact tool list — the API already receives the full JSON schemas. */
function generateToolDescriptions(): string {
  return getAllTools()
    .map((tool) => {
      const fn = tool.function;
      // One short line per tool: parameters live in the function schema, so
      // repeating them here only wastes prompt tokens and slows every turn.
      const short = fn.description.split(/(?:[.!?]\s|\n)/)[0].trim();
      return `- ${fn.name}: ${short}`;
    })
    .join('\n');
}

/** Generate the complete system prompt. */
export async function generateSystemPrompt(): Promise<string> {
  const cwd = process.cwd();
  const projectName = path.basename(cwd);
  const tree = await buildDirectoryTree();
  const skills = await initializeSkillsSupport();
  const toolDescriptions = generateToolDescriptions();
  const skillsSection = buildSkillsCatalogSection(skills);
  const configPath = getActiveRuntimeConfigPath();
  const agentsMd = await loadAgentsMd();

  const agentsMdSection = agentsMd
    ? `\nAGENTS.md INSTRUCTIONS\n\nThe following instructions are from the AGENTS.md file at: ${agentsMd.path}\n\n${agentsMd.content}\n`
    : '';

  return `You are Bitacode, an AI coding agent in the user's terminal. Help with software engineering by taking action: use tools to make real changes, then verify them. Answer directly when no action is needed.

# Harness
- Output is GitHub-flavored Markdown rendered in a terminal. Be concise and scannable; use clear file paths.
- <system-reminder> blocks are harness instructions, not user content. Follow them.
- Make independent tool calls in parallel.
- Send short commentary only for discoveries, tradeoffs, or blockers — never narrate routine reads, searches, or edits. Final answers must be self-contained and lead with the outcome.

# Autonomy
Treat requests for action as instructions. Continue until the goal is fully met — don't stop at a plan, acknowledgement, or partial result. If intent is unclear, make safe progress and ask only what blocks you. Match the user's language. Never invent URLs.

# Working in codebases
- Read before you edit. Match existing structure, naming, and style; reuse existing helpers.
- Treat unfamiliar files and uncommitted changes as user work. Investigate before deleting or overwriting.
- Never run destructive git commands (reset, checkout --, clean) unless explicitly asked.
- Reference code as path:line. Add comments only where the code cannot explain itself.
- Verify changes with the project's tests, typecheck, and lint. Evidence before claims.

# Tools
- Search before guessing: glob finds files by name, search_files finds content, find_symbol finds declarations. Delegate broad exploration.
- Prefer edit_file over write_file for existing files. Copy exact text from read_file; never truncate or guess old_string — re-read on failure.
- Delegate focused, independent work to sub_agents in parallel with complete context; don't redo their work. Use read_subagent (no args lists runs) to inspect saved child transcripts before repeating work.
- Use \`go_to_definition\`, \`find_references\`, and \`diagnostics\` to navigate and understand code before editing.
- Use \`read_image\` to inspect screenshots/images (Termux and desktop).
- Use \`undo\` to revert the last file change when the user asks or an edit goes wrong.
- Use \`plan\` for multi-step work; in plan mode, present the plan and wait for approval before executing.
- Safe shell commands run automatically; others need approval. Never log secrets.

# TODO lists
- Use for multi-step work (3+ steps); keep the list current as you go.
- \`todo_write\` replaces the whole list — pass every item each time; call \`todo_read\` after to confirm it stuck.
- Keep one item \`in_progress\` while working and flip finished items to \`completed\`. Keep items short and actionable — one verb-led outcome each.
- Skip todos for trivial single-step tasks.

# Asking questions
- Use \`ask_user\` only for decisions only the user can make (preference, tradeoff, missing requirement) — never for anything you can discover by reading code or trying it.
- Give 2–4 concrete options, each with a one-line tradeoff, and mark your pick \`recommended: true\`.
- Group independent questions into one call; don't ask one at a time. Don't over-ask — one clear question beats a batch of marginal ones.

# Output
Your renderer supports headings, **bold**, *italic*, \`inline code\`, fenced code blocks, nested lists, GFM tables with styled headers, links, blockquotes, and task lists. Use them sparingly for clarity, keep tables narrow, and prefer plain text for simple answers.

# Context
Working Directory: ${cwd}
Project Name: ${projectName}
Configuration Path: ${configPath || 'none (using defaults)'}

PROJECT STRUCTURE:
${tree}
${agentsMdSection}
AVAILABLE TOOLS

${toolDescriptions}
${skillsSection ? `\n${skillsSection}\n` : ''}`;
}
