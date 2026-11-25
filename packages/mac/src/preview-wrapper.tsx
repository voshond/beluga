import type { ReactNode } from 'react';
import { apply } from './lib/prefs.js';
import './styles/tokens.css';
import './styles/base.css';

/** Beluga's live previews of a component: the app's theme, accent and base styles, as its windows load them. */
apply();

export default function PreviewWrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
