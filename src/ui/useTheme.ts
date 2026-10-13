import { useEffect, useState } from 'react';
import { useStore } from '../state/store';

const query = () => window.matchMedia('(prefers-color-scheme: dark)');

/** Resolves the theme preference ('system' follows the OS) and applies it to <html>. */
export function useEffectiveTheme(): 'light' | 'dark' {
  const pref = useStore((s) => s.prefs.theme);
  const [systemDark, setSystemDark] = useState(() => query().matches);
  useEffect(() => {
    const mq = query();
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}

export function useApplyTheme(): void {
  const theme = useEffectiveTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1e2329' : '#1f3a5f');
  }, [theme]);
}
