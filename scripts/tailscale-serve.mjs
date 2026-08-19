#!/usr/bin/env node
/**
 * Publishes the local server onto the tailnet and prints the HTTPS URL.
 * Everything it does is a plain `tailscale` command, printed before it runs, so
 * nothing here is a black box — you can run the same commands by hand.
 */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const port = process.env.PORT ?? '4823';
const off = process.argv.includes('--off');

function tailscale(args, { quiet = false } = {}) {
  if (!quiet) console.log(`$ tailscale ${args.join(' ')}`);
  return execFileSync('tailscale', args, { encoding: 'utf8' });
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

let status;
try {
  status = JSON.parse(tailscale(['status', '--json'], { quiet: true }));
} catch (err) {
  fail(`Could not talk to tailscaled: ${err.message.split('\n')[0]}\n  Start Tailscale, then run this again.`);
}

if (status.BackendState !== 'Running') {
  fail(
    `Tailscale is not running (state: ${status.BackendState}).\n` +
      `  Start it with:  tailscale up`,
  );
}

const dnsName = (status.Self?.DNSName ?? '').replace(/\.$/, '');
if (!dnsName) fail('Tailscale did not report a DNS name for this machine.');

const httpsEnabled = Array.isArray(status.CertDomains) && status.CertDomains.length > 0;
if (!httpsEnabled) {
  console.warn(
    '\n⚠ No cert domains reported. Enable HTTPS certificates for your tailnet in the admin console:\n' +
      '  https://login.tailscale.com/admin/dns  →  "HTTPS Certificates" → Enable\n' +
      '  MagicDNS must be on as well. Continuing anyway…\n',
  );
}

if (off) {
  tailscale(['serve', '--https=443', 'off']);
  console.log('\n✓ Serve mapping removed.');
  process.exit(0);
}

// --bg keeps the mapping in tailscaled so it survives this script exiting.
tailscale(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);

console.log('\n' + tailscale(['serve', 'status'], { quiet: true }));

const url = `https://${dnsName}/`;
console.log(`✓ Reachable from any device on your tailnet:\n\n    ${url}\n`);
console.log('Notes:');
console.log('  • Funnel is NOT enabled: this URL only resolves inside your tailnet.');
console.log('  • Turn the mapping off again with:  tailscale serve --https=443 off');
console.log('  • Add the URL to your iPhone home screen for a full-screen console.');

// A quick liveness check so a misconfigured port is obvious immediately.
try {
  const { stdout } = await exec('curl', ['-fsS', '--max-time', '3', `http://127.0.0.1:${port}/api/health`]);
  console.log(`\nLocal health check: ${stdout.trim()}`);
} catch {
  console.warn(`\n⚠ Nothing is answering on http://127.0.0.1:${port} yet. Start the server with: npm start`);
}
