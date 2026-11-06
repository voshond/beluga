import { useEffect, useState } from 'react';
import type { InstructionPieceView } from '@beluga/shared/agent-setup.js';
import { useApi } from '../../lib/beluga.js';
import { Group, Row } from '../settings-controls.js';
import s from '../settings.module.css';
import a from './agent-setup.module.css';

const Piece = ({ piece }: { readonly piece: InstructionPieceView }) => {
  const [open, setOpen] = useState(false);

  const handleToggle = () => setOpen((was) => !was);

  return (
    <div className={a.piece}>
      <button type="button" className={a.pieceHead} aria-expanded={open} aria-label={`${piece.label}: ${open ? 'hide' : 'show'} its text`} onClick={handleToggle}>
        <span className={a.pieceLabel}>{piece.label}</span>
        <span className={a.muted}>{piece.when}</span>
        <span className={a.flex} />
        <code className={`${a.code} ${a.muted}`}>{piece.source}</code>
      </button>
      {open ? <pre className={a.pre}>{piece.text ?? 'Written for each run from what it is doing, so there is no fixed text to show. See its source.'}</pre> : null}
    </div>
  );
};

export const BuiltInInstructions = () => {
  const api = useApi();
  const [pieces, setPieces] = useState<readonly InstructionPieceView[]>();

  useEffect(() => {
    void api.agentSetup.instructions().then(setPieces);
  }, [api]);

  return (
    <Group title="Built-in instructions">
      <Row label="What Beluga adds to every run" detail="In this order. Claude Code gets them in its system prompt, Codex as developer instructions. To change one, edit its source and open a pull request.">
        <span />
      </Row>
      {pieces === undefined ? <div className={s.note}>Looking…</div> : pieces.map((piece) => <Piece key={piece.id} piece={piece} />)}
    </Group>
  );
};
