import React, { useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { LeftBar } from './LeftBar.js';
import { stripMouseReports } from '../utils/mouse.js';
import type { AskQuestion, AskResponse } from '../tools/ask.js';

export interface AskPromptProps {
  questions: AskQuestion[];
  columns: number;
  onRespond: (response: AskResponse) => void;
}

interface Answered {
  [questionId: string]: string;
}

/** Marker shown next to the agent's own recommendation. */
const RECOMMENDED_TAG = 'recommended';
/** Marker shown for a chosen option in multi-select mode. */
const CHECKED = '◉';
const UNCHECKED = '◯';

function clampText(text: string, width: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= width) return single;
  if (width <= 1) return '…';
  return `${single.slice(0, width - 1)}…`;
}

/**
 * Interactive "the agent is asking you something" prompt.
 *
 * Design goals:
 *  - keyboard driven, no mouse required
 *  - one question at a time, so multi-question asks stay readable
 *  - options are pre-selected-able and the agent's recommendation is marked
 *  - typing is always allowed unless the question sets allow_free_text false
 *  - a progress line makes a multi-question ask feel bounded
 */
export const AskPrompt: React.FC<AskPromptProps> = ({ questions, columns, onRespond }) => {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answered>({});
  const [cursor, setCursor] = useState(0);
  // useInput closes over the render it was registered in, so a fast
  // "down then enter" sequence could commit the previously highlighted
  // option. Mirror the cursor in a ref that updates synchronously and read
  // that inside the key handler.
  const cursorRef = useRef(0);
  const moveCursor = (next: number) => {
    cursorRef.current = next;
    setCursor(next);
  };
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  // Multi-select state: option indexes chosen for the current question.
  const [picked, setPicked] = useState<number[]>([]);
  // Same staleness problem as the cursor: the input handler must see the
  // selections made earlier in the same burst, not the ones from this render.
  const pickedRef = useRef<number[]>([]);
  const setPickedNow = (next: number[]) => {
    pickedRef.current = next;
    setPicked(next);
  };

  const question = questions[index];
  const total = questions.length;
  const options = question?.options ?? [];
  const canType = question?.allow_free_text !== false;
  const hasOptions = options.length > 0;
  const width = Math.max(20, columns - 8);

  const currentAnswer = (): string => {
    if (question?.multiple && pickedRef.current.length > 0) {
      return pickedRef.current
        .slice()
        .sort((a, b) => a - b)
        .map((optionIndex) => options[optionIndex]?.label)
        .filter(Boolean)
        .join(', ');
    }
    if (typing || !hasOptions) return draft.trim();
    return options[cursorRef.current]?.label ?? '';
  };

  const commit = (value: string) => {
    const trimmed = value.trim();
    const next: Answered = { ...answers, [question.id ?? `q${index + 1}`]: trimmed };
    setAnswers(next);

    if (index + 1 < total) {
      // Advance to the next question and reset its own input state.
      setIndex(index + 1);
      moveCursor(0);
      setTyping(false);
      setDraft('');
      setPickedNow([]);
      return;
    }

    // Last question: hand every answer back in ask order.
    onRespond(
      questions.map((entry, entryIndex) => ({
        id: entry.id ?? `q${entryIndex + 1}`,
        question: entry.question,
        answer: next[entry.id ?? `q${entryIndex + 1}`] ?? '',
      }))
    );
  };

  useInput((input, key) => {
    if (!question) return;

    if (key.escape) {
      // Esc declines the whole ask rather than trapping the user in it.
      onRespond(
        questions.map((entry, entryIndex) => ({
          id: entry.id ?? `q${entryIndex + 1}`,
          question: entry.question,
          answer: '',
        }))
      );
      return;
    }

    if (typing) {
      if (key.return) {
        commit(draft);
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((prev) => prev.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
      const text = stripMouseReports(input).replace(/[\r\n\t]+/g, ' ');
      if (text) setDraft((prev) => prev + text);
      return;
    }

    if (key.upArrow) {
      if (hasOptions) moveCursor((cursorRef.current - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      if (hasOptions) moveCursor((cursorRef.current + 1) % options.length);
      return;
    }

    // Tab switches between picking an option and typing a custom answer.
    if (key.tab) {
      if (canType && hasOptions) {
        setTyping(true);
        setDraft('');
      }
      return;
    }

    // A number key jumps straight to that option.
    if (hasOptions && /^[1-9]$/.test(input)) {
      const optionIndex = Number(input) - 1;
      if (optionIndex < options.length) {
        if (question.multiple) {
          const previous = pickedRef.current;
          setPickedNow(
            previous.includes(optionIndex)
              ? previous.filter((entry) => entry !== optionIndex)
              : [...previous, optionIndex]
          );
        } else {
          moveCursor(optionIndex);
          commit(options[optionIndex].label);
        }
      }
      return;
    }

    if (key.return) {
      if (question.multiple) {
        if (pickedRef.current.length > 0) {
          commit(currentAnswer());
        } else if (hasOptions) {
          setPickedNow([cursorRef.current]);
        }
        return;
      }
      commit(currentAnswer());
      return;
    }

    // Start typing when the question is free-text only, or on a printable key.
    if (canType && !hasOptions) {
      setTyping(true);
      const text = stripMouseReports(input).replace(/[\r\n\t]+/g, ' ');
      if (text) setDraft(text);
    }
  });

  if (!question) return null;

  return (
    <LeftBar color={theme.accent} marginTop={1} marginBottom={1}>
      <Box flexDirection="column">
        <Text>
          <Text color={theme.accent} bold>
            Agent question
          </Text>
          {total > 1 && (
            <Text color={theme.dim}>{`  ${index + 1}/${total}`}</Text>
          )}
        </Text>

        <Text color={theme.text} bold wrap="wrap">
          {question.question}
        </Text>
        {question.context && (
          <Text color={theme.dim} wrap="wrap">
            {clampText(question.context, width * 2)}
          </Text>
        )}

        {hasOptions && (
          <Box flexDirection="column" marginTop={1}>
            {options.map((option, optionIndex) => {
              const active = !typing && optionIndex === cursor;
              const isPicked = question.multiple ? picked.includes(optionIndex) : active;
              const marker = question.multiple ? (isPicked ? CHECKED : UNCHECKED) : active ? '❯' : ' ';
              return (
                <Box key={`${option.label}-${optionIndex}`} flexDirection="column">
                  <Text wrap="truncate-end">
                    <Text color={isPicked ? theme.accent : theme.dim}>{`${active ? '❯' : ' '} `}</Text>
                    {question.multiple && (
                      <Text color={isPicked ? theme.accent : theme.dim}>{`${marker} `}</Text>
                    )}
                    <Text color={active ? theme.text : theme.muted} bold={active}>
                      {`${optionIndex + 1}. ${clampText(option.label, width - 8)}`}
                    </Text>
                    {option.recommended && (
                      <Text color={theme.success}>{`  ${RECOMMENDED_TAG}`}</Text>
                    )}
                  </Text>
                  {active && option.description && (
                    <Text color={theme.dim} wrap="truncate-end">
                      {`     ${clampText(option.description, width - 8)}`}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        )}

        {typing && (
          <Box marginTop={1}>
            <Text>
              <Text color={theme.accent}>{'> '}</Text>
              <Text color={theme.text}>{draft}</Text>
              <Text inverse>{' '}</Text>
            </Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text color={theme.dim} wrap="truncate-end">
            {typing
              ? 'type your answer · enter send · esc skip'
              : [
                  hasOptions ? '↑↓ or 1-9 pick' : 'type your answer',
                  hasOptions && canType ? 'tab type' : '',
                  question.multiple ? 'enter toggle/confirm' : 'enter send',
                  'esc skip',
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </Text>
        </Box>
      </Box>
    </LeftBar>
  );
};
