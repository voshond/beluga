// First: zod never probes eval (blocked by the CSP, BLG-672), and Beluga's storage keys become Beluga's before any module reads them.
import '../lib/zod-jitless.js';
import '../lib/storage-rename.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { inApp } from '../lib/boot.js';
import { apply } from '../lib/prefs.js';
import { CallFloat } from './CallFloat.js';
import '../styles/tokens.css';
import '../styles/base.css';
import '../popup/popup.css';

/** The floating call card's own window (see src-tauri/src/call_float.rs): your theme and accent, the card. */
apply();
if (inApp()) document.documentElement.dataset.app = 'tauri';
document.documentElement.dataset.popup = 'true';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CallFloat />
  </StrictMode>,
);
