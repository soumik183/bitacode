import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { logger } from '../utils/logger.js';
/**
 * Last line of defence for render errors. Without it React unmounts the whole
 * TUI (which looks like the CLI quitting after a request); here the terminal
 * stays open and ctrl+c still exits.
 */
export class ErrorBoundary extends React.Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error, info) {
        logger.error('UI render error', {
            error: error.message,
            stack: error.stack,
            componentStack: info.componentStack,
        });
    }
    render() {
        if (!this.state.error)
            return this.props.children;
        return (_jsxs(Box, { flexDirection: "column", paddingX: 2, paddingY: 1, children: [_jsx(Text, { color: theme.error, bold: true, children: "Bitacode hit an unexpected UI error." }), _jsx(Text, { color: theme.muted, children: this.state.error.message }), _jsx(Text, { color: theme.dim, children: "Press ctrl+c to quit. Completed turns are already saved." })] }));
    }
}
