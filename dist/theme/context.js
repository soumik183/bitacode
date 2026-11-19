import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useMemo } from 'react';
import { getTheme } from './palettes.js';
const ThemeContext = createContext(null);
/**
 * Publishes one immutable palette to every descendant. The palette is derived
 * with `useMemo`, so changing the name re-renders consumers without ever
 * mutating a module-level object during render.
 */
export const ThemeProvider = ({ name, children }) => {
    const palette = useMemo(() => getTheme(name), [name]);
    return _jsx(ThemeContext.Provider, { value: palette, children: children });
};
/**
 * Current palette. Outside a provider this returns the default (black) palette,
 * so components rendered standalone by ink-testing-library keep working.
 */
export function useTheme() {
    return useContext(ThemeContext) ?? getTheme();
}
