import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HONCHO_DEFAULT_WORKSPACE, HONCHO_LOCAL_URL, HONCHO_ID_RE, type HonchoStatus } from '../../shared/honcho.js';
import { belugaHome } from '../home.js';

export const HonchoConfig = z.object({
  enabled: z.boolean().default(false),
  url: z.string().url().default(HONCHO_LOCAL_URL),
  apiKey: z.string().min(1).max(4096).optional(),
  workspace: z.string().regex(HONCHO_ID_RE).default(HONCHO_DEFAULT_WORKSPACE),
  excluded: z.array(z.string().max(200)).max(500).default([]),
  since: z.number().optional(),
  sent: z.number().int().nonnegative().default(0),
  lastSentAt: z.number().optional(),
  lastError: z.string().max(300).optional(),
});
export type HonchoConfig = z.infer<typeof HonchoConfig>;

export const honchoPath = (): string => path.join(belugaHome(), 'honcho.json');

export const defaultHonchoConfig = (): HonchoConfig => HonchoConfig.parse({});

export const loadHonchoConfig = (file: string = honchoPath()): HonchoConfig => {
  try {
    const parsed = HonchoConfig.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : defaultHonchoConfig();
  } catch {
    return defaultHonchoConfig();
  }
};

export const saveHonchoConfig = (config: HonchoConfig, file: string = honchoPath()): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(HonchoConfig.parse(config), null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
};

export const trimUrl = (url: string): string => url.trim().replace(/\/+$/, '');

export const statusOf = (config: HonchoConfig, queued: number): HonchoStatus => ({
  enabled: config.enabled,
  url: config.url,
  workspace: config.workspace,
  hasKey: Boolean(config.apiKey),
  excluded: config.excluded,
  ...(config.since !== undefined ? { since: config.since } : {}),
  sent: config.sent,
  ...(config.lastSentAt !== undefined ? { lastSentAt: config.lastSentAt } : {}),
  ...(config.lastError ? { lastError: config.lastError } : {}),
  queued,
});
