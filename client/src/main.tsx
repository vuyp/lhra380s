import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles/tokens.css';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Whale Watch could not start: #root is missing from the document');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker only makes sense against built, hashed assets.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is a bonus, never a requirement — the app works without it.
    });
  });
}
