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

## Usage (3 steps)

**1. Server (once):**
```bash
sudo bash install-hub.sh
```
It installs Docker, builds and starts the `robot-tunnel-hub` container, installs the
`robot-hub` command, and prints the **server public key**. Copy that key.
Firewall: allow only `2222/tcp` inbound.

**2. Robot (per robot):**
```bash
sudo bash setup-robot-tunnel-client.sh
```
Answer the prompts (name, SN, reverse port e.g. `22001`, robot SSH user, notes), paste the
**server public key** when asked. It builds and starts the `robot-tunnel-client` container
(autossh) and prints the **robot public key**. Copy that key.

**3. Server — register the robot:**
```bash
robot-hub        # -> add -> paste robot public key, use the SAME reverse port
```
Then `robot-hub` → `select` → `connect` / `sftp`.

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

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Permission denied (publickey)` in robot logs | robot public key not added on hub, or wrong port |
| `connect` asks for the robot user's password | server public key not in the robot user's `authorized_keys`, or hub key missing |
| robot online but tunnel loops on `remote port forwarding failed` | stale tunnel on the hub; `ClientAliveInterval` frees it within ~90s |
| logs show `hub@...` instead of `robot-tunnel@...` | an old service/config is still running — the setup script stops the known ones |

Check on the server: `ss -tlnp | grep -E '2222|2200'` → expect `0.0.0.0:2222` and
`127.0.0.1:22001` (never `0.0.0.0:22001`).
