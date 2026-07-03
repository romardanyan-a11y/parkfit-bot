# Robot Tunnel Hub — reverse SSH access to Linux robots

Access Linux robots that sit behind NAT / SIM / grey IP, with **no inbound ports** on the
robots. Each robot dials out to your public-IP VPS and holds a reverse SSH tunnel. You pick a
robot from a menu on the VPS and get an SSH/SFTP session straight into it.

```
[Linux Robot] ── reverse SSH tunnel ──> [Linux VPS, public IP]
                                              ^
[Operator] ───────────────────────────────────┘
```

Two files, run one on each side:

- `install-hub.sh` — run once on the **VPS/server**.
- `setup-robot-tunnel-client.sh` — run once on **each robot**.

## Setup — server once

```bash
sudo bash install-hub.sh
```
Installs Docker, builds/starts the `robot-tunnel-hub` container, installs the `robot-hub`
command, and prints the **server public key**. Firewall: allow `2222/tcp` inbound (and
`2223/tcp` only while pairing — see sync mode).

Then pair each robot in **one of two ways**:

### A) Sync mode (recommended — automatic key exchange)

No copy/paste. The machines exchange keys over the network with your approval.

1. **Server:** `robot-hub` → `sync`. It shows a 6-digit **pairing code** and listens on
   TCP `2223` for one robot (open `2223/tcp` for this window).
2. **Robot:** `sudo bash setup-robot-tunnel-client.sh` → choose mode **1 (sync)**, answer
   the details, enter the **server IP** and the **pairing code**.
3. **Server:** a dialog shows the robot's name/SN/user/key → **Approve**. Done: a free
   reverse port is assigned automatically, both keys are installed, the tunnel starts.

On success *or* failure, **both machines print their SSH keys** to the console so you can
always fall back to manual pairing.

**Retry a failed sync without re-typing the details** — the setup saves them the first
time, so afterwards just run:
```bash
sudo bash robot-sync.sh              # asks only for the pairing code
sudo bash robot-sync.sh rebuild      # no exchange: just rebuild image + restart container
```

### B) Manual mode (copy/paste)

1. **Robot:** run setup, choose mode **2 (manual)**, enter a reverse port (e.g. `22001`),
   paste the **server public key**. It prints the **robot public key**.
2. **Server:** `robot-hub` → `add` → paste the robot public key, use the **same** port.

After pairing (either way): `robot-hub` → `select` → `connect` / `sftp`.

## Why it stays up and doesn't hang

- **autossh** on the robot (`-M 0`, `ServerAlive*`, `ExitOnForwardFailure`, `AUTOSSH_GATETIME=0`)
  reconnects automatically; Docker `--restart unless-stopped` survives reboots.
- **Server-side `ClientAliveInterval 30` / `CountMax 3`** reap dead tunnels so a returning
  robot can re-bind its port instead of failing on "port in use".
- **Persistent host keys** (`/data/ssh/host_keys`) survive image rebuilds — no host-key
  mismatch that would lock every robot out.
- **Persistent `known_hosts`** on the robot (`/config/known_hosts`).

## Security

- Robots authenticate to the hub as the locked-down `robot-tunnel` user
  (`nologin` shell, `no-pty`), restricted per-robot by
  `restrict,port-forwarding,permitlisten="127.0.0.1:<PORT>"`.
- Hub sshd: `PasswordAuthentication no`, `PermitRootLogin no`, `AllowUsers robot-tunnel`,
  `AllowTcpForwarding remote`, `GatewayPorts no` → reverse ports live only on `127.0.0.1`.
- The hub reaches robots as your chosen `robot_user` using the hub→robot key
  (`/data/ssh/hub_to_robot_ed25519`), so `connect` never asks for a password.
- Sync mode is guarded twice: a one-time pairing code **and** an explicit approve dialog
  on the server. The listener runs only during that window and accepts a single robot.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Permission denied (publickey)` in robot logs | robot public key not added on hub, or wrong port |
| `connect` asks for the robot user's password | server public key not in the robot user's `authorized_keys`, or hub key missing |
| robot online but tunnel loops on `remote port forwarding failed` | stale tunnel on the hub; `ClientAliveInterval` frees it within ~90s |
| logs show `hub@...` instead of `robot-tunnel@...` | an old service/config is still running — the setup script stops the known ones |

Check on the server: `ss -tlnp | grep -E '2222|2200'` → expect `0.0.0.0:2222` and
`127.0.0.1:22001` (never `0.0.0.0:22001`).
