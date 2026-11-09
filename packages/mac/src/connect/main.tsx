import '../lib/zod-jitless.js';
import '../lib/storage-rename.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { inApp } from '../lib/boot.js';
import { apply } from '../lib/prefs.js';
import { Connect } from './Connect.js';
import '../styles/tokens.css';
import '../styles/base.css';
import './connect.css';

apply();
if (inApp()) document.documentElement.dataset.app = 'tauri';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Connect />
  </StrictMode>,
);
