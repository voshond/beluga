import { IconButton } from '../components/ui.js';
import { inApp } from '../lib/boot.js';
import { goBack, useCanGoBack } from '../lib/web-history.js';

export function WebBack() {
  const canGoBack = useCanGoBack();
  if (inApp()) return null;
  return <IconButton icon="back" label="Back" disabled={!canGoBack} onClick={goBack} />;
}
