import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * LeftBar — renders a bold gray vertical bar (│) on the left side of
 * content, like a GitHub "note" callout. The bar stretches to match the
 * full height of the content by measuring the content box after each render
 * and repeating the │ character once per row.
 *
 * Uses Ink's measureElement (available in stock Ink) rather than a Box
 * border, so it adds zero extra border lines and avoids ghosting on resize.
 */
import { useRef, useState, useLayoutEffect } from 'react';
import { Box, Text, measureElement } from 'ink';
import { useTheme } from '../theme.js';
export const LeftBar = ({ color, children, marginTop = 0, marginBottom = 0, }) => {
    const theme = useTheme();
    const barColor = color ?? theme.border;
    const contentRef = useRef(null);
    const [height, setHeight] = useState(1);
    useLayoutEffect(() => {
        if (contentRef.current) {
            try {
                const { height: h } = measureElement(contentRef.current);
                if (h > 0)
                    setHeight(h);
            }
            catch {
                // measureElement can throw before layout is complete; keep previous height
            }
        }
    });
    const bar = Array.from({ length: height }, () => '│').join('\n');
    return (_jsxs(Box, { flexDirection: "row", marginTop: marginTop, marginBottom: marginBottom, overflow: "hidden", children: [_jsx(Box, { flexDirection: "column", marginRight: 1, children: _jsx(Text, { color: barColor, bold: true, children: bar }) }), _jsx(Box, { ref: contentRef, flexDirection: "column", flexGrow: 1, children: children })] }));
};
