import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { logger } from '../utils/logger.js';

/** Functional fallback so the error card can read the active palette. */
const Fallback: React.FC<{ message: string }> = ({ message }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.error} bold>
        Bitacode hit an unexpected UI error.
      </Text>
      <Text color={theme.muted}>{message}</Text>
      <Text color={theme.dim}>
        Press ctrl+c to quit. Completed turns are already saved.
      </Text>
    </Box>
  );
};

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence for render errors. Without it React unmounts the whole
 * TUI (which looks like the CLI quitting after a request); here the terminal
 * stays open and ctrl+c still exits.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logger.error('UI render error', {
      error: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <Fallback message={this.state.error.message} />;
  }
}
