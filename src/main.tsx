import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { setupLaunchQueue } from './pwa/launchQueue';
import { setupServiceWorker } from './pwa/registerSW';
import { useStore } from './state/store';

// First run on a narrow screen: start with the palettes closed so the view has room.
try {
  if (!localStorage.getItem('rvt-viewer:prefs') && window.innerWidth < 800) {
    useStore.getState().setPrefs({ showProperties: false, showBrowser: false, ribbonMinimized: true });
  }
} catch {
  // Storage unavailable: keep defaults.
}

setupLaunchQueue();
setupServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
