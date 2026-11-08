import { ownTempRoot } from '../src/daemon/temp-root.js';

export default function setup(): () => void {
  const { remove } = ownTempRoot('test');
  process.once('exit', remove);
  return () => {
    process.off('exit', remove);
    remove();
  };
}
