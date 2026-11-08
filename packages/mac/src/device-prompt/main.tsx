import '../lib/zod-jitless.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { apply } from '../lib/prefs.js';
import { DevicePrompt } from './DevicePrompt.js';
import '../styles/tokens.css';
import '../styles/base.css';
import './device-prompt.css';

apply();
document.documentElement.dataset.app = 'tauri';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DevicePrompt />
  </StrictMode>,
);
