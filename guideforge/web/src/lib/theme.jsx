import { createContext, useContext, useEffect, useMemo, useState } from "react";

const ThemeContext = createContext(null);

function getSystemTheme() {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
}

export function ThemeProvider({ children, defaultTheme = "light" }) {
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return defaultTheme;
    return localStorage.getItem("guideforge-theme") || defaultTheme;
  });

  const resolved = useMemo(
    () => (theme === "system" ? getSystemTheme() : theme),
    [theme],
  );

  useEffect(() => {
    applyTheme(resolved);
    localStorage.setItem("guideforge-theme", theme);
  }, [theme, resolved]);

  useEffect(() => {
    if (theme !== "system") return undefined;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(getSystemTheme());
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,
      resolved,
      setTheme,
      toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    }),
    [theme, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
