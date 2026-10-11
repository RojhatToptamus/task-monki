import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
// The interface and code faces ship with the app; nothing is fetched at runtime.
import '@fontsource-variable/instrument-sans/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found.');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
