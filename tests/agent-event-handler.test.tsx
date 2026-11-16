import test from 'node:test';
import assert from 'node:assert/strict';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { waitForFrame, waitFor } from './helpers/wait.js';
import type { AgentEvent, Message } from '../src/agentic-loop.js';
import {
  useAgentEventHandler,
  type AssistantMessageRef,
  type InlineThreadError,
  type StreamingBuffer,
} from '../src/hooks/useAgentEventHandler.js';

// A fast stream can emit `done` before React runs the state updater from the
// first text delta. The handler must still archive the reply and clear the
// live cursor; otherwise the TUI looks stuck after a completed request.
test('a fast text delta followed by done archives the reply and clears streaming state', async () => {
  const Harness = () => {
    const [items, setItems] = useState<React.ReactNode[]>([]);
    const [streamingText, setStreamingText] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [, setMessages] = useState<Message[]>([]);
    const [, setThinking] = useState('');
    const [, setThinkingArchived] = useState(false);
    const [, setThinkingStartedAt] = useState<number | null>(null);
    const [, setActiveTool] = useState<string | null>(null);
    const [, setUsage] = useState<AgentEvent['usage'] | null>(null);
    const [, setCost] = useState(0);
    const [, setThreadErrors] = useState<InlineThreadError[]>([]);
    const [, setError] = useState<string | null>(null);
    const reasoningRef = useRef('');
    const assistantMessageRef = useRef<AssistantMessageRef | null>(null);
    const streamingBufferRef = useRef<StreamingBuffer>({
      unflushedContent: '',
      hasFlushedAnyLine: false,
      lastUiUpdate: 0,
    });

    const addStatic = useCallback((node: React.ReactNode) => {
      setItems((prev) => [...prev, node]);
    }, []);

    const handleAgentEvent = useAgentEventHandler({
      addStatic,
      setCompletionMessages: setMessages,
      setIsStreaming,
      setStreamingText,
      setThinkingText: setThinking,
      setThinkingArchived,
      setThinkingStartedAt,
      reasoningRef,
      setActiveTool,
      setLastUsage: setUsage,
      setTotalCost: setCost,
      setThreadErrors,
      setError,
      assistantMessageRef,
      streamingBufferRef,
    });

    const ran = useRef(false);
    useEffect(() => {
      if (ran.current) return;
      ran.current = true;
      handleAgentEvent({ type: 'text_delta', content: 'fast response' });
      handleAgentEvent({ type: 'done' });
    }, [handleAgentEvent]);

    return (
      <Box flexDirection="column">
        {items}
        {isStreaming && <Text>{streamingText}▍</Text>}
      </Box>
    );
  };

  const { lastFrame } = render(<Harness />);
  // Poll instead of sleeping: the archived text must appear without the cursor.
  const frame = await waitForFrame(lastFrame, (f) => /fast response/.test(f) && !/▍/.test(f));

  assert.match(frame, /fast response/);
  assert.doesNotMatch(frame, /▍/);
});

test('reasoning archives once above the reply with its elapsed time', async () => {
  const state = { thinkingText: '', thinkingArchived: false, startedAt: null as number | null };
  let thinkingExpanded = false;

  const Harness = () => {
    const [items, setItems] = useState<React.ReactNode[]>([]);
    const [, setIsStreaming] = useState(false);
    const [, setStreamingText] = useState('');
    const [, setMessages] = useState<Message[]>([]);
    const [thinking, setThinking] = useState('');
    const [archived, setThinkingArchived] = useState(false);
    const [startedAt, setThinkingStartedAt] = useState<number | null>(null);
    const [, setActiveTool] = useState<string | null>(null);
    const [, setUsage] = useState<AgentEvent['usage'] | null>(null);
    const [, setCost] = useState(0);
    const [, setThreadErrors] = useState<InlineThreadError[]>([]);
    const [, setError] = useState<string | null>(null);
    const reasoningRef = useRef('');
    const assistantMessageRef = useRef<AssistantMessageRef | null>(null);
    const streamingBufferRef = useRef<StreamingBuffer>({
      unflushedContent: '',
      hasFlushedAnyLine: false,
      lastUiUpdate: 0,
    });

    const addStatic = useCallback((node: React.ReactNode) => {
      setItems((prev) => [...prev, node]);
    }, []);

    const handleAgentEvent = useAgentEventHandler({
      addStatic,
      setCompletionMessages: setMessages,
      setIsStreaming,
      setStreamingText,
      setThinkingText: (value) => {
        setThinking(value);
        state.thinkingText = value;
        if (typeof value === 'function') return;
      },
      setThinkingArchived: (value) => {
        const next = typeof value === 'function' ? value(archived) : value;
        setThinkingArchived(next);
        state.thinkingArchived = next;
      },
      setThinkingStartedAt: (value) => {
        const next = typeof value === 'function' ? value(startedAt) : value;
        setThinkingStartedAt(next);
        state.startedAt = next;
      },
      reasoningRef,
      setActiveTool,
      setLastUsage: setUsage,
      setTotalCost: setCost,
      setThreadErrors,
      setError,
      assistantMessageRef,
      streamingBufferRef,
    });

    const ran = useRef(false);
    useEffect(() => {
      if (ran.current) return;
      ran.current = true;
      handleAgentEvent({ type: 'reasoning_delta', content: 'The user said hi' });
      handleAgentEvent({ type: 'text_delta', content: 'Hello back' });
      handleAgentEvent({ type: 'done' });
      thinkingExpanded = false;
    }, [handleAgentEvent]);

    return (
      <Box flexDirection="column">
        {items}
        {thinking && !archived && <Text>▾ Thought</Text>}
      </Box>
    );
  };

  const { lastFrame } = render(<Harness />);
  await waitFor(() => state.thinkingArchived && state.startedAt === null);
  const frame = await waitForFrame(lastFrame, (f) => /Thought/.test(f) && /Hello back/.test(f));

  assert.equal(state.thinkingArchived, true);
  assert.equal(state.thinkingText, '');
  assert.equal(state.startedAt, null);
  assert.equal((frame.match(/Thought/g) ?? []).length, 1);
  assert.match(frame, /Thought.*<1s · 16 chars/s);
  assert.ok(frame.indexOf('Thought') < frame.indexOf('Hello back'));
});
