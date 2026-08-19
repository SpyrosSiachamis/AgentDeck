# Reaching the console from your phone

The app listens on `127.0.0.1:4823` and never on your LAN interface.
`tailscale serve` is what makes it reachable — and only from devices on your own
tailnet. No port forwarding, no public IP, no Funnel.

## One-time tailnet configuration

Serve issues a real TLS certificate for your machine's MagicDNS name, which
requires two settings in the admin console at
<https://login.tailscale.com/admin/dns>:

1. **MagicDNS** — enabled.
2. **HTTPS Certificates** — enabled.

Without these, `tailscale serve --https=443` cannot obtain a certificate and
your phone gets a TLS error.

Check the machine is ready:

```bash
tailscale status                      # BackendState should be "Running"
tailscale status --json | grep -i certdomains
```

## Publishing the app

The helper verifies the prerequisites, prints each command it runs, and tells you
the URL:

```bash
npm run serve:tailscale
```

Or do it by hand:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4823
tailscale serve status
```

`--bg` stores the mapping in `tailscaled`, so it survives the terminal closing
and comes back after a reboot. The URL is your machine's MagicDNS name:

```
https://<machine>.<your-tailnet>.ts.net/
```

Open that on your phone (the phone must be on the tailnet and connected), then
**Share → Add to Home Screen** for a full-screen console.

## Turning it off

```bash
tailscale serve --https=443 off      # or: npm run serve:tailscale -- --off
tailscale serve status               # should report no config
```

## Explicitly not used

- **Funnel** (`tailscale funnel`) would publish this to the public internet.
  Never enable it for this app: it exposes an endpoint that can execute code on
  your machine. There is no configuration in this repository that turns it on.
- **Port forwarding / public IPs** are not needed and not supported.
- **`tailscale serve` on the LAN interface** — the app refuses to bind to a
  non-loopback address by default precisely to prevent this.

## Restricting access further

Tailscale ACLs decide which devices may reach this machine. To allow only your
phone, add something like this to your tailnet policy file:

```jsonc
{
  "acls": [
    {
      "action": "accept",
      "src":    ["tag:my-phone"],
      "dst":    ["tag:dev-machine:443"]
    }
  ]
}
```

Then narrow it inside the app as well:

```bash
REQUIRE_TAILSCALE_IDENTITY=true
ALLOWED_TAILSCALE_USERS=you@example.com
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Tailscale is stopped` | daemon not running | `tailscale up` |
| Certificate error on the phone | HTTPS certs or MagicDNS off | enable both in the admin DNS page |
| 502 from the Serve URL | the app is not running | `npm start`, then `curl localhost:4823/api/health` |
| 403 on every request | `REQUIRE_TAILSCALE_IDENTITY=true` and you are hitting `127.0.0.1` directly | use the Serve URL, or unset it while debugging locally |
| Serve mapping vanished after reboot | published without `--bg` | re-run with `--bg` |
| Phone works on Wi-Fi, not on cellular | Tailscale not connected on the phone | enable the VPN toggle in the Tailscale app |
| WebSocket keeps dropping | phone suspended the tab | expected; the client reconnects and replays missed events on wake |
