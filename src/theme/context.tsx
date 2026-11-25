import React, { createContext, useContext, useMemo } from 'react';
import type { Theme } from './types.js';
import { customThemeVersion, getTheme } from './palettes.js';

const ThemeContext = createContext<Theme | null>(null);

export interface ThemeProviderProps {
  /** Selected palette name; unknown/missing values fall back to black. */
  name?: string;
  children: React.ReactNode;
}

/**
 * Publishes one immutable palette to every descendant. The palette is derived
 * with `useMemo`, so changing the name re-renders consumers without ever
 * mutating a module-level object during render.
 */
export const ThemeProvider: React.FC<ThemeProviderProps> = ({ name, children }) => {
  // `customThemeVersion` is a live ESM binding: registering a theme after the
  // first render changes the memo key, so the next provider render resolves the
  // new palette instead of keeping the placeholder captured on mount.
  const palette = useMemo(() => getTheme(name), [name, customThemeVersion]);
  return <ThemeContext.Provider value={palette}>{children}</ThemeContext.Provider>;
};

/**
 * Current palette. Outside a provider this returns the default (black) palette,
 * so components rendered standalone by ink-testing-library keep working.
 */
export function useTheme(): Theme {
  return useContext(ThemeContext) ?? getTheme();
}
