import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "light" | "dark";
type Preference = Theme | "system";
const STORAGE_KEY = "notebook-factory:theme";

function readPreference(): Preference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch { /* Storage is optional. */ }
  return "system";
}

// @lat: [[architecture#Notebook Factory#Appearance]]
export function useTheme() {
  const [preference, setPreference] = useState(readPreference);
  const [system, setSystem] = useState<Theme>(() => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const theme = preference === "system" ? system : preference;
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystem(media.matches ? "dark" : "light");
    const sync = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) setPreference(readPreference()); };
    update();
    media.addEventListener("change", update);
    window.addEventListener("storage", sync);
    return () => { media.removeEventListener("change", update); window.removeEventListener("storage", sync); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#000000" : "#ffffff");
  }, [theme]);
  function choose(value: Preference) {
    setPreference(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* Storage is optional. */ }
  }
  return { theme, preference, choose };
}

export function ThemeSwitcher({ preference, onChange }: { preference: Preference; onChange: (value: Preference) => void }) {
  const Icon = preference === "system" ? Monitor : preference === "light" ? Sun : Moon;
  return <label className="theme-switcher" title={`Theme: ${preference}`}>
    <Icon size={15} aria-hidden="true" />
    <select aria-label="Theme" value={preference} onChange={event => onChange(event.target.value as Preference)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>;
}
