import { baseName } from '@beluga/shared/os-path.js';
import { useState } from 'react';
import { Button } from '../components/ui.js';
import { useBeluga } from '../lib/beluga.js';
import { revealInFinder } from '../lib/files.js';
import { problemIssueUrl } from '../lib/report.js';
import { GITHUB_URL } from '../lib/support.js';
import { openExternal } from '../lib/system.js';
import { Row } from './settings-controls.js';

const ABOUT = 'One file of what Beluga did lately and anything that went wrong, without your secrets. It opens a GitHub issue to attach it to.';

/** Settings › About › Report a Problem: make the black box's report, show it, and open an issue for it (BLG-673). */
export function ReportProblemRow() {
  const { client } = useBeluga();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const report = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const made = await client.api.diagnostics.report();
      await revealInFinder(client, made.path);
      await openExternal(problemIssueUrl(GITHUB_URL, made.summary, baseName(made.path)));
    } catch (err) {
      setError(`Couldn't make the report: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row label="Report a Problem" detail={error ?? ABOUT}>
      <Button size="small" icon="bug" disabled={busy} onClick={() => void report()}>
        {busy ? 'Making…' : 'Make a Report…'}
      </Button>
    </Row>
  );
}
