/** The rule src-tauri/src/remote.rs enforces (and the web port follows): https, or plain http only on this computer. */

export type UrlCheck = { readonly ok: true; readonly origin: string; readonly url: string } | { readonly ok: false; readonly error: string };

const NAME_MAX = 64;

const isLoopback = (host: string): boolean => {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
};

const fail = (error: string): UrlCheck => ({ ok: false, error });

const parse = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

export const checkServerUrl = (raw: string): UrlCheck => {
  const trimmed = raw.trim();
  if (!trimmed) return fail('Enter your Beluga server’s address.');
  const full = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  const notUrl = fail('That isn’t a web address. Try https://your-server.your-tailnet.ts.net');
  const url = parse(full);
  if (!url?.hostname) return notUrl;
  if (url.username || url.password) return fail('Leave the user name and password out of the address: you sign in on the server’s page.');
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) return fail('Use an https:// address. Plain http:// is only for 127.0.0.1 or localhost, through an SSH tunnel.');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('Only https:// addresses work (or http://127.0.0.1 through an SSH tunnel).');
  return { ok: true, origin: url.origin, url: url.href };
};

export const checkDeviceName = (raw: string): string | null => {
  const name = raw.trim();
  if (!name) return 'Give this device a name, so agents can tell it apart.';
  if ([...name].length > NAME_MAX) return `Keep the device name under ${NAME_MAX} characters.`;
  if (/\p{Cc}/u.test(name)) return 'The device name can’t hold line breaks or tabs.';
  return null;
};
