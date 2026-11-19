import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App';
import { tauriBridge } from './services/tauriBridge';

const rootEl = document.getElementById('root') as HTMLElement;

if (tauriBridge.isTauri() && tauriBridge.consumeBootDocument) {
  const bootPromise = tauriBridge.consumeBootDocument().catch(() => null);
  void bootPromise.then((bootDoc) => {
    createRoot(rootEl).render(
      <App initialBootDoc={bootDoc} bootResolved={true} />
    );
  });
} else {
  createRoot(rootEl).render(<App />);
}
