export const HONCHO_CLOUD_URL = 'https://api.honcho.dev';

export const HONCHO_LOCAL_URL = 'http://localhost:8000';

export const HONCHO_DEFAULT_WORKSPACE = 'beluga';

export const HONCHO_ID_RE = /^[a-zA-Z0-9_-]{1,512}$/;

export type HonchoStatus = {
  readonly enabled: boolean;
  readonly url: string;
  readonly workspace: string;
  readonly hasKey: boolean;
  readonly excluded: readonly string[];
  readonly since?: number;
  readonly sent: number;
  readonly lastSentAt?: number;
  readonly lastError?: string;
  readonly queued: number;
};

export type HonchoTestResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** How hard Honcho's own model thinks about a question (BLG-101): `low` is the default, the higher ones are slower. */
export const HONCHO_REASONING = ['minimal', 'low', 'medium', 'high', 'max'] as const;

export type HonchoReasoning = (typeof HONCHO_REASONING)[number];

/** What Honcho holds about the user now (BLG-101), for Settings and the phone. `error` when it couldn't be read. */
export type HonchoPicture = { readonly enabled: boolean; readonly text: string; readonly at?: number; readonly error?: string };
