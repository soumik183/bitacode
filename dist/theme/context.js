import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useMemo } from 'react';
import { customThemeVersion, getTheme } from './palettes.js';
const ThemeContext = createContext(null);
/**
 * Publishes one immutable palette to every descendant. The palette is derived
 * with `useMemo`, so changing the name re-renders consumers without ever
 * mutating a module-level object during render.
 */
export const ThemeProvider = ({ name, children }) => {
    // `customThemeVersion` is a live ESM binding: registering a theme after the
    // first render changes the memo key, so the next provider render resolves the
    // new palette instead of keeping the placeholder captured on mount.
    const palette = useMemo(() => getTheme(name), [name, customThemeVersion]);
    return _jsx(ThemeContext.Provider, { value: palette, children: children });
};
/**
 * Current palette. Outside a provider this returns the default (black) palette,
 * so components rendered standalone by ink-testing-library keep working.
 */
export function useTheme() {
    return useContext(ThemeContext) ?? getTheme();
}
