import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { logger } from '../utils/logger.js';

/** Functional fallback so the bad-row card can read the active palette. */
const Fallback: React.FC = () => {
  const theme = useTheme();
  return (
    <Box paddingX={2} marginBottom={1}>
      <Text color={theme.error}>Could not render this transcript item.</Text>
    </Box>
  );
};

interface Props {
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Keeps one malformed saved message or card from taking down the whole
 * transcript. The bad row is replaced and the rest of the session still works.
 */
export class EntryErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logger.error('Transcript item render error', {
      error: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return <Fallback />;
  }
}
