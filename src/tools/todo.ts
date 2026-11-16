/**
 * todo_read / todo_write tools - in-memory task tracking.
 *
 * The agent uses these to plan multi-step work and track progress.
 * Todos are stored per session. The active session can also persist them
 * through the session store.
 */

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
}

const DEFAULT_SESSION_ID = '__default__';

// Session-scoped in-memory storage
const todosBySession = new Map<string, TodoItem[]>();

function getSessionKey(sessionId?: string): string {
  return sessionId ?? DEFAULT_SESSION_ID;
}

function cloneTodos(todos: TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function formatTodos(todos: TodoItem[], heading: string): string {
  if (todos.length === 0) {
    return `${heading}\nNo TODOs.`;
  }

  const statusIcons: Record<TodoItem['status'], string> = {
    pending: '[ ]',
    in_progress: '[~]',
    completed: '[x]',
    cancelled: '[-]',
  };

  const lines = todos.map((t) => `${statusIcons[t.status]} [${t.priority}] ${t.content} (${t.id})`);
  return `${heading}\n${lines.join('\n')}`;
}

export const todoReadTool = {
  type: 'function' as const,
  function: {
    name: 'todo_read',
    description: 'Read the current TODO list to check progress on tasks.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

export const todoWriteTool = {
  type: 'function' as const,
  function: {
    name: 'todo_write',
    description: 'Replace the TODO list with an updated version. Use this to plan tasks, update progress, and mark items complete.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete updated TODO list.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier for the item.' },
              content: { type: 'string', description: 'Description of the task.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                description: 'Current status.',
              },
              priority: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: 'Priority level.',
              },
            },
            required: ['id', 'content', 'status', 'priority'],
          },
        },
      },
      required: ['todos'],
    },
  },
};

export function readTodos(sessionId?: string): string {
  const todos = todosBySession.get(getSessionKey(sessionId)) ?? [];
  return formatTodos(todos, `TODO List (${todos.length} items):`);
}

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);
const MAX_TODOS = 100;

export function writeTodos(newTodos: TodoItem[], sessionId?: string): string {
  if (!Array.isArray(newTodos)) {
    return 'Error: todos must be an array of todo items.';
  }
  if (newTodos.length > MAX_TODOS) {
    return `Error: too many todos (${newTodos.length}); the limit is ${MAX_TODOS}.`;
  }

  const todos: TodoItem[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < newTodos.length; index++) {
    const todo = newTodos[index];
    if (!todo || typeof todo !== 'object') {
      return `Error: todo at index ${index} must be an object.`;
    }

    const id = typeof todo.id === 'string' ? todo.id.trim() : '';
    const content = typeof todo.content === 'string' ? todo.content.trim() : '';
    if (!id) {
      return `Error: todo at index ${index} is missing a non-empty "id".`;
    }
    if (!content) {
      return `Error: todo "${id}" is missing non-empty "content".`;
    }
    if (!VALID_STATUSES.has(todo.status)) {
      return `Error: todo "${id}" has invalid status "${todo.status}". Use pending, in_progress, completed, or cancelled.`;
    }
    if (!VALID_PRIORITIES.has(todo.priority)) {
      return `Error: todo "${id}" has invalid priority "${todo.priority}". Use high, medium, or low.`;
    }
    if (seenIds.has(id)) {
      return `Error: duplicate todo id "${id}".`;
    }

    seenIds.add(id);
    todos.push({ id, content: content.slice(0, 500), status: todo.status, priority: todo.priority });
  }

  todosBySession.set(getSessionKey(sessionId), todos);
  return formatTodos(todos, `TODO List Updated (${todos.length} items):`);
}

export function getTodosForSession(sessionId?: string): TodoItem[] {
  return cloneTodos(todosBySession.get(getSessionKey(sessionId)) ?? []);
}

export function setTodosForSession(sessionId: string, todos: TodoItem[]): void {
  todosBySession.set(getSessionKey(sessionId), cloneTodos(todos));
}

export function clearTodos(sessionId?: string): void {
  todosBySession.delete(getSessionKey(sessionId));
}
