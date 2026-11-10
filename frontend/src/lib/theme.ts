import { useCallback, useSyncExternalStore } from "react";

/**
 * Light / dark color scheme. The choice is `html.dark` (src/index.css swaps the
 * theme tokens on it); the inline script in index.html sets it before first
 * paint from the same storage key, so a reload never flashes the wrong scheme.
 * Without a saved choice the OS preference applies, and follows it live.
 */
export type Theme = "light" | "dark";

/** Shared by every node on the origin, so the choice carries across nodes.
 * Keep in sync with index.html. */
const STORAGE_KEY = "fiesta-theme";

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Follow the OS while the user has not chosen.
  const onSystem = (event: MediaQueryListEvent) => {
    if (!savedTheme()) applyTheme(event.matches ? "dark" : "light");
  };
  const query = media();
  query.addEventListener("change", onSystem);
  return () => {
    listeners.delete(listener);
    query.removeEventListener("change", onSystem);
  };
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private mode): the choice lasts for this page.
  }
  applyTheme(theme);
}

/** The active theme and a toggle that saves the other one. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  const toggle = useCallback(() => setTheme(currentTheme() === "dark" ? "light" : "dark"), []);
  return { theme, toggle };
}
