import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../src/theme.js';
import { addToolResultView } from '../src/utils/tool-result-view.js';

function frame(name: string, args: unknown, result: string): string {
  const nodes: React.ReactNode[] = [];
  addToolResultView((node) => { nodes.push(node); }, name, JSON.stringify(args), result);
  const view = render(<ThemeProvider name="black">{nodes[0]}</ThemeProvider>);
  const text = stripAnsi(view.lastFrame() ?? '');
  view.unmount();
  return text;
}

test('transcript shows a friendly tool title and hint, not raw snake_case', () => {
  assert.match(frame('search_files', { search_term: 'bug' }, '1 match'), /▶ Search files · "bug"/);
  assert.match(frame('todo_write', { todos: [{ content: 'a', status: 'pending' }] }, 'ok'), /▶ Todo add · 1 items/);
  assert.match(frame('mcp__github__list_issues', { x: 'y' }, '[]'), /▶ MCP tool · list_issues/);
  assert.match(frame('git_commit', { message: 'fix: label' }, 'ok'), /▶ Git commit · fix: label/);
  const all = frame('search_files', { search_term: 'bug' }, '1 match');
  assert.doesNotMatch(all, /search_files/, 'raw tool name is gone');
});

test('error results keep the friendly title and error color text', () => {
  const text = frame('git_commit', { message: 'fix bug' }, 'Error: git failed');
  assert.match(text, /▶ Git commit · fix bug: Error: git failed/);
});
