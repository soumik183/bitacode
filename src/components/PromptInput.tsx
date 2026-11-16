import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { stripMouseReports } from '../utils/mouse.js';
import { theme } from '../theme.js';

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  isDisabled?: boolean;
  mask?: boolean;
}

/**
 * Single-line prompt input.
 *
 * Owned by us instead of @inkjs/ui so control keys (ctrl+a, ctrl+d, …) never
 * get inserted as text, and so the cursor is drawn in our own palette.
 */
export const PromptInput: React.FC<PromptInputProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  isDisabled = false,
  mask = false,
}) => {
  const [cursor, setCursor] = useState(value.length);
  const offset = Math.min(cursor, value.length);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.leftArrow) {
        setCursor(Math.max(0, offset - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, offset + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (offset === 0) return;
        onChange(value.slice(0, offset - 1) + value.slice(offset));
        setCursor(offset - 1);
        return;
      }
      // Ignore every other control/modifier key: they are never text.
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return;

      // Mouse reports arrive as text (Ink strips the leading ESC); never insert them.
      const text = stripMouseReports(input).replace(/[\r\n\t]+/g, ' ');
      if (!text) return;
      onChange(value.slice(0, offset) + text + value.slice(offset));
      setCursor(offset + text.length);
    },
    { isActive: !isDisabled }
  );

  if (!value) {
    return <Text color={theme.placeholder}>{placeholder}</Text>;
  }

  const display = mask ? '*'.repeat(value.length) : value;
  const before = display.slice(0, offset);
  const at = display[offset] ?? ' ';
  const after = display.slice(offset + 1);

  return (
    <Text color={theme.text}>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
};
