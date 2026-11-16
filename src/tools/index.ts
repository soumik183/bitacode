/**
 * Tool registry — collects all tool definitions and provides a dispatcher.
 *
 * Each tool file exports:
 *  - A tool definition (OpenAI function-calling JSON schema)
 *  - A handler function (args) => Promise<string>
 *
 * This file wires them together into a single `tools` array and
 * a `handleToolCall(name, args)` dispatcher.
 */

import { readFileTool, readFile } from './read-file.js';
import { writeFileTool, writeFile } from './write-file.js';
import { editFileTool, editFile } from './edit-file.js';
import { listDirectoryTool, listDirectory } from './list-directory.js';
import { searchFilesTool, searchFiles } from './search-files.js';
import { globTool, globFiles } from './glob.js';
import { bashTool, runBash } from './bash.js';
import { todoReadTool, todoWriteTool, readTodos, writeTodos } from './todo.js';
import { webfetchTool, webfetch } from './webfetch.js';
import { askQuestionTool, askUser, normalizeAskRequest } from './ask.js';

export { setDangerouslySkipPermissions, setApprovalHandler, clearApprovalHandler, setApprovalMode, getApprovalMode } from '../utils/approval.js';
export type { ApprovalMode } from '../settings.js';
export { setAskHandler, clearAskHandler, hasAskHandler } from './ask.js';
export type { AskRequest, AskResponse, AskAnswer, AskQuestion, AskOption } from './ask.js';

export interface ToolCallContext {
  sessionId?: string;
  abortSignal?: AbortSignal;
}

// All tool definitions — passed to the LLM
export const tools = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  searchFilesTool,
  globTool,
  bashTool,
  todoReadTool,
  todoWriteTool,
  webfetchTool,
  askQuestionTool,
];

export type DynamicTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

// Mutable tools list — MCP and sub-agent tools get appended at runtime
let dynamicTools: DynamicTool[] = [];

export function registerDynamicTool(tool: DynamicTool): void {
  const toolName = tool.function.name;
  dynamicTools = dynamicTools.filter((existing) => existing.function.name !== toolName);
  dynamicTools.push(tool);
}

export function unregisterDynamicTool(toolName: string): void {
  dynamicTools = dynamicTools.filter((tool) => tool.function.name !== toolName);
}

export function clearDynamicTools(): void {
  dynamicTools = [];
}

export function getAllTools() {
  return [...tools, ...dynamicTools];
}

// Dynamic tool handlers (for MCP tools, etc.)
const dynamicHandlers = new Map<string, (args: any) => Promise<string>>();

export function registerDynamicHandler(name: string, handler: (args: any) => Promise<string>): void {
  dynamicHandlers.set(name, handler);
}

export function unregisterDynamicHandler(name: string): void {
  dynamicHandlers.delete(name);
}

/**
 * Dispatch a tool call to the appropriate handler.
 * Returns the tool result as a string.
 */
const MAX_TOOL_RESULT_CHARS = 50_000;

/**
 * Keep tool output within a predictable budget so one oversized result
 * (huge file, web page, MCP response) cannot blow up the model context.
 */
export function truncateToolResult(result: string): string {
  const sanitized = String(result).replaceAll('\0', '');
  if (sanitized.length <= MAX_TOOL_RESULT_CHARS) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_TOOL_RESULT_CHARS)}\n... (tool result truncated, ${sanitized.length} chars total)`;
}

export async function handleToolCall(toolName: string, args: any, context: ToolCallContext = {}): Promise<string> {
  if (args == null) {
    args = {};
  } else if (typeof args !== 'object' || Array.isArray(args)) {
    return `Error: arguments for "${toolName}" must be a JSON object.`;
  }

  try {
    const result = await dispatchToolCall(toolName, args, context);
    return truncateToolResult(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error executing ${toolName}: ${msg}`;
  }
}

async function dispatchToolCall(toolName: string, args: any, context: ToolCallContext): Promise<string> {
  switch (toolName) {
    case 'read_file':
      if (args.ranges != null && (args.offset != null || args.limit != null)) {
        return 'Error: use either ranges or offset/limit, not both.';
      }
      return await readFile(args.file_path, args.offset, args.limit, context.sessionId, args.ranges);
    case 'write_file':
      return await writeFile(args.file_path, args.content, context.sessionId);
    case 'edit_file':
      return await editFile(args.file_path, args.old_string, args.new_string, args.expected_replacements, context.sessionId);
    case 'list_directory':
      return await listDirectory(args.directory_path);
    case 'search_files':
      return await searchFiles(args.search_term, args.directory_path, args.case_sensitive, args.file_extensions, context.abortSignal);
    case 'glob':
      return await globFiles(args.pattern, args.directory_path);
    case 'bash':
      return await runBash(args.command, args.timeout_ms, context.sessionId, context.abortSignal);
    case 'todo_read':
      return readTodos(context.sessionId);
    case 'todo_write':
      return writeTodos(args.todos, context.sessionId);
    case 'webfetch': {
      const result = await webfetch(args.url, args.format, args.timeout);
      return JSON.stringify(result);
    }
    case 'ask_user': {
      const request = normalizeAskRequest(args);
      return await askUser(request, context.sessionId);
    }
    default: {
      // Check dynamic handlers (MCP tools, sub-agent tools)
      const handler = dynamicHandlers.get(toolName);
      if (handler) {
        return await handler(args);
      }
      const available = [...tools, ...dynamicTools].map((tool) => tool.function.name).join(', ');
      return `Error: Unknown tool "${toolName}". Available tools: ${available}`;
    }
  }
}
