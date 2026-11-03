import { config } from 'zod';

/**
 * zod checks schemas without compiling them (BLG-672). Its compiled fast path first probes
 * `new Function("")`; under a page's content security policy (the web port's, the app's: no
 * unsafe-eval) that probe is blocked, and browsers report it as a CSP error even though zod
 * catches it. Imported first by main.tsx and popup/main.tsx, before any schema parses.
 */
config({ jitless: true });
