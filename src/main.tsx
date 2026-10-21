import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'dockview-react/dist/styles/dockview.css';
import './index.css';
import './workspace/theme.css';
import './app/shell.css';
import { App } from './App';

async function start(): Promise<void> {
  // Plain browser (`npx vite`): run the real DocHost in-page with stubbed engine/IO.
  if (!window.krypt) {
    const { installMockKrypt } = await import('./dev/mockKrypt');
    installMockKrypt();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
