# Deployment — systemd (VPS)

Procedure and rollback live in [`../RUNBOOK.md`](../RUNBOOK.md); this directory
holds the unit template and the two run-mode profiles.

## Files

| File | Purpose |
|---|---|
| `systemd/liquidation.service` | Unit template: build-on-start, restart-on-failure, hardened (ProtectSystem=strict, NoNewPrivileges, PrivateTmp). |
| `systemd/soak.conf` | **Soak profile** (Phase 4): `DRY_RUN=true`, metrics → `metrics-soak.jsonl`. |
| `systemd/golive.conf` | **Go-live profile** (Phase 6): `DRY_RUN=false`, metrics → `metrics.jsonl`. Real money — install only after the go/no-go gate passes. |

The two profiles are mutually exclusive: whichever `.conf` sits in the unit's
drop-in directory last-installed wins for the keys it sets — check with
`systemctl show liquidation -p Environment` after any switch.

## Install

```bash
# 1. Unit + profiles
sudo cp deploy/systemd/liquidation.service /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/liquidation.service.d
sudo cp deploy/systemd/soak.conf /etc/systemd/system/liquidation.service.d/   # start in soak

# 2. Secrets (never committed; 0600, owned by the service user)
sudo mkdir -p /etc/liquidation /var/log/liquidation
sudo vim /etc/liquidation/liquidation.env
sudo chmod 600 /etc/liquidation/liquidation.env

# 3. Enable
sudo systemctl daemon-reload
sudo systemctl enable --now liquidation
journalctl -u liquidation -f
```

`liquidation.env` keys (see `RUNBOOK.md` §6 for the full table):

```ini
RPC_URL_4663=...
RPC_URL_4663_FALLBACKS=https://rpc.mainnet.chain.robinhood.com
WS_RPC_URL_4663=...
EXECUTOR_ADDRESS_4663=0x...
LIQUIDATION_PRIVATE_KEY_4663=0x...
HEALTH_PORT=3000
```

## Healthcheck

The bot serves `GET /health` on `HEALTH_PORT` (default `3000`, loopback only):

- **200 `{"status":"ok"}`** — every registered chain completes evaluation cycles.
- **503 `{"status":"degraded"}`** — a chain booted but never completed a cycle,
  or its last completed cycle is >24h old (the safety poll alone fires every
  30s, so a day of silence means the cycle loop is hung).
- `chains[]` exposes per-chain `runs`, `errors`, and seconds since the last
  cycle start/completion — grep it in dashboards.

Wire it to monitoring (loopback — reach it via SSH tunnel or a local exporter):

```bash
curl -s http://127.0.0.1:3000/health | jq .
```

Docker deployments get the equivalent check built in (`HEALTHCHECK` in the
`Dockerfile`, same endpoint).
