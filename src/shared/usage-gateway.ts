export const USAGE_GATEWAY_DEFAULT_URL = 'https://ai-gateway.nihilum.io';

export const USAGE_SOURCES = ['local', 'gateway'] as const;

export type UsageSource = (typeof USAGE_SOURCES)[number];

export const USAGE_GATEWAY_POLL_MS = 5 * 60_000;

export const USAGE_GATEWAY_PROVIDERS = ['claude', 'codex'] as const;

export type UsageGatewayProvider = (typeof USAGE_GATEWAY_PROVIDERS)[number];

export type UsageGatewayProviderCheck = { readonly ok: boolean; readonly error?: string };

export type UsageGatewayProviders = Readonly<Record<UsageGatewayProvider, UsageGatewayProviderCheck>>;

export type UsageGatewayStatus = {
  readonly source: UsageSource;
  readonly url: string;
  readonly hasKey: boolean;
  readonly checkedAt?: number;
  readonly lastError?: string;
  readonly providers?: UsageGatewayProviders;
};

export type UsageGatewayCheck = { readonly ok: true; readonly providers: UsageGatewayProviders } | { readonly ok: false; readonly error: string };
