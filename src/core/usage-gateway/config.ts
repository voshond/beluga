import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { USAGE_GATEWAY_DEFAULT_URL, USAGE_SOURCES } from '../../shared/usage-gateway.js';
import { belugaHome } from '../home.js';

export const UsageGatewayConfig = z.object({
  source: z.enum(USAGE_SOURCES).default('local'),
  url: z.string().url().default(USAGE_GATEWAY_DEFAULT_URL),
  key: z.string().min(1).max(4096).optional(),
});

export type UsageGatewayConfig = z.infer<typeof UsageGatewayConfig>;

export const usageGatewayPath = (): string => path.join(belugaHome(), 'usage-gateway.json');

export const defaultUsageGatewayConfig = (): UsageGatewayConfig => UsageGatewayConfig.parse({});

export const loadUsageGatewayConfig = (file: string = usageGatewayPath()): UsageGatewayConfig => {
  try {
    const parsed = UsageGatewayConfig.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : defaultUsageGatewayConfig();
  } catch {
    return defaultUsageGatewayConfig();
  }
};

export const saveUsageGatewayConfig = (config: UsageGatewayConfig, file: string = usageGatewayPath()): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(UsageGatewayConfig.parse(config), null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
};

export const trimGatewayUrl = (url: string): string => url.trim().replace(/\/+$/, '');
