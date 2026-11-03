#!/usr/bin/env node
// A stand-in for the Tailscale CLI in the end-to-end tests (the demo daemon runs it as BELUGA_TAILSCALE):
// logged in as kay@example.com on demo-box.tail-e2e.ts.net; `serve` works and changes nothing real.
const args = process.argv.slice(2);
if (args[0] === 'status') {
  process.stdout.write(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'demo-box.tail-e2e.ts.net.', UserID: 1 }, User: { 1: { LoginName: 'kay@example.com' } } }));
  process.exit(0);
}
if (args[0] === 'serve') {
  if (!args.includes('off')) process.stdout.write(`Available within your tailnet:\n\nhttps://demo-box.tail-e2e.ts.net/\n|-- proxy ${args.at(-1)}\n`);
  process.exit(0);
}
process.stderr.write(`fake-tailscale: no ${args.join(' ')}\n`);
process.exit(2);
