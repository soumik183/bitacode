import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { logger } from '../utils/logger.js';
/** Functional fallback so the bad-row card can read the active palette. */
const Fallback = () => {
    const theme = useTheme();
    return (_jsx(Box, { paddingX: 2, marginBottom: 1, children: _jsx(Text, { color: theme.error, children: "Could not render this transcript item." }) }));
};
/**
 * Keeps one malformed saved message or card from taking down the whole
 * transcript. The bad row is replaced and the rest of the session still works.
 */
export class EntryErrorBoundary extends React.Component {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    componentDidCatch(error, info) {
        logger.error('Transcript item render error', {
            error: error.message,
            stack: error.stack,
            componentStack: info.componentStack,
        });
    }
    render() {
        if (!this.state.failed)
            return this.props.children;
        return _jsx(Fallback, {});
    }
}
