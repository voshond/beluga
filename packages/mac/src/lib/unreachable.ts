const RESTARTING = new Set([502, 503, 504]);

/** Why the server's endpoint answered with something that isn't Beluga's (a proxy's error page while it restarts). */
export const unreachableDetail = (status: number, statusText: string): string => {
  const code = `${status}${statusText ? ` ${statusText}` : ''}`;
  if (RESTARTING.has(status)) return `The server is restarting (${code}). Beluga reconnects by itself.`;
  return `The server answered with a page Beluga didn’t expect (${code}).`;
};
