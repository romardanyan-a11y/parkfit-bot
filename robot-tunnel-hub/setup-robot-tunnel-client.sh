#!/usr/bin/env bash
#
# setup-robot-tunnel-client.sh  --  ONE-SHOT setup for a robot (client side).
#
# Run this once on the robot (as root):
#     sudo bash setup-robot-tunnel-client.sh
#
# It will:
#   - install Docker if missing, verify the robot's own sshd is on port 22
#   - stop/disable any old reverse-tunnel systemd services
#   - ask for the robot details (tunnel user is ALWAYS robot-tunnel, not asked)
#   - generate the robot key, install the hub's public key for hub->robot access
#   - build & (re)create the autossh container that keeps the reverse tunnel up
#   - print the robot public key to add on the hub via `robot-hub` > add
#
set -euo pipefail

# ------------------------------ defaults ------------------------------
VPS_HOST_DEFAULT="155.212.159.244"
VPS_SSH_PORT_DEFAULT="2222"
TUNNEL_USER="robot-tunnel"            # fixed, never asked
IMAGE="robot-tunnel-client:latest"
CONTAINER="robot-tunnel-client"
CDIR="/opt/robot-tunnel-client"
BUILD="$CDIR/build"

# Sync client: send our request JSON, read the server response, drop results to files.
# argv: host port code name sn robot_user notes pubkey outdir
PYCLIENT="$(cat <<'PYEOF'
import socket, sys, json
host, port, code, name, sn, user, notes, pubkey, outdir = sys.argv[1:10]
req = json.dumps({"v": 1, "code": code, "name": name, "sn": sn,
                  "robot_user": user, "notes": notes, "pubkey": pubkey})
try:
    s = socket.create_connection((host, int(port)), timeout=300)
    s.settimeout(300)
    f = s.makefile("rwb", buffering=0)
    f.write(req.encode() + b"\n")
    line = f.readline()
    resp = json.loads(line.decode())
except Exception as e:
    open(outdir + "/.sync_result", "w").write("SYNC_STATUS=error\n")
    print("error:", e); sys.exit(1)
if resp.get("status") == "ok":
    with open(outdir + "/.sync_result", "w") as fh:
        fh.write("SYNC_STATUS=ok\n")
        fh.write("SYNC_PORT=%d\n" % int(resp.get("port", 0)))
        fh.write("SYNC_HUB_SSH_PORT=%d\n" % int(resp.get("hub_ssh_port", 2222)))
    open(outdir + "/.sync_hub_pubkey", "w").write((resp.get("hub_pubkey", "") or "").strip() + "\n")
    print("ok: paired on reverse port", resp.get("port")); sys.exit(0)
else:
    open(outdir + "/.sync_result", "w").write("SYNC_STATUS=%s\n" % resp.get("status", "rejected"))
    print("rejected:", resp.get("reason", "")); sys.exit(3)
PYEOF
)"

log(){ printf '\033[1;36m[robot]\033[0m %s\n' "$*"; }
err(){ printf '\033[1;31m[robot] ERROR:\033[0m %s\n' "$*" >&2; }
ask(){ local p="$1" d="${2:-}" a; if [ -n "$d" ]; then read -rp "$p [$d]: " a; echo "${a:-$d}"; else read -rp "$p: " a; echo "$a"; fi; }

[ "$(id -u)" = "0" ] || { err "Please run as root (sudo)."; exit 1; }

# ------------------------------ robot sshd on :22 ------------------------------
if command -v ss >/dev/null 2>&1 && ! ss -H -tln 'sport = :22' 2>/dev/null | grep -q .; then
  log "No sshd on port 22 detected. Installing openssh-server ..."
  if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y openssh-server; fi
  systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true
fi

# ------------------------------ docker ------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found. Installing via get.docker.com ..."
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker 2>/dev/null || true
command -v ssh-keygen >/dev/null 2>&1 || { apt-get install -y openssh-client 2>/dev/null || true; }

# ------------------------------ kill old services ------------------------------
if command -v systemctl >/dev/null 2>&1; then
  for s in robot-reverse-tunnel.service robot-tunnel.service reverse-ssh.service; do
    systemctl stop "$s" 2>/dev/null || true
    systemctl disable "$s" 2>/dev/null || true
  done
fi

# ------------------------------ mode + details ------------------------------
echo
echo "Setup mode:"
echo "  1) sync   - automatic SSH key exchange with the server (recommended)"
echo "  2) manual - copy/paste the public keys yourself"
MODE=$(ask "Choose mode [1=sync, 2=manual]" "1")
case "$MODE" in 1|2) : ;; *) MODE=1;; esac

# Reuse previously entered details as defaults (so you don't retype them).
mkdir -p "$CDIR" "$BUILD"
if [ -f "$CDIR/robot.conf" ]; then
  # shellcheck disable=SC1091
  . "$CDIR/robot.conf"
  log "Found saved details for '${ROBOT_NAME:-?}'. Press Enter to keep each value."
fi

echo
log "Enter robot details (tunnel user is always '$TUNNEL_USER', not asked):"
ROBOT_NAME=$(ask "Robot name" "${ROBOT_NAME:-}")
ROBOT_SN=$(ask "Robot SN" "${ROBOT_SN:-}")
VPS_HOST=$(ask "VPS host/IP" "${VPS_HOST:-$VPS_HOST_DEFAULT}")
VPS_SSH_PORT=$(ask "VPS SSH port" "${VPS_SSH_PORT:-$VPS_SSH_PORT_DEFAULT}")
ROBOT_USER=$(ask "Robot SSH/SFTP user (e.g. siasun, root, robot)" "${ROBOT_USER:-robot}")
NOTES=$(ask "Notes" "${NOTES:-}")
getent passwd "$ROBOT_USER" >/dev/null || { err "User '$ROBOT_USER' does not exist on this robot."; exit 1; }

# Persist details NOW (before the exchange) so a later 'resync' needs only the code.
cat > "$CDIR/robot.conf" <<CONF
ROBOT_NAME=$ROBOT_NAME
ROBOT_SN=$ROBOT_SN
VPS_HOST=$VPS_HOST
VPS_SSH_PORT=$VPS_SSH_PORT
ROBOT_USER=$ROBOT_USER
NOTES=$NOTES
CONF

# ------------------------------ robot key ------------------------------
if [ ! -f "$CDIR/id_ed25519" ]; then
  log "Generating robot key ..."
  ssh-keygen -q -t ed25519 -f "$CDIR/id_ed25519" -N "" -C "robot-$ROBOT_NAME"
fi
chmod 600 "$CDIR/id_ed25519"
touch "$CDIR/known_hosts"

# ------------------------------ obtain server key (sync or manual) ------------------------------
if [ "$MODE" = "1" ]; then
  command -v python3 >/dev/null 2>&1 || { log "Installing python3 for sync ..."; apt-get install -y python3 2>/dev/null || true; }
  command -v python3 >/dev/null 2>&1 || { err "python3 not available; re-run and choose manual mode (2)."; exit 1; }
  PAIR_PORT=$(ask "Server pairing port" "2223")
  CODE=$(ask "Pairing code shown on the server (sync mode)")
  echo
  log "Contacting $VPS_HOST:$PAIR_PORT for automatic key exchange (approve on the server) ..."
  if python3 -c "$PYCLIENT" "$VPS_HOST" "$PAIR_PORT" "$CODE" \
       "$ROBOT_NAME" "$ROBOT_SN" "$ROBOT_USER" "$NOTES" "$(cat "$CDIR/id_ed25519.pub")" "$CDIR"; then
    # shellcheck disable=SC1091
    . "$CDIR/.sync_result"
    VPS_PORT="$SYNC_PORT"
    VPS_SSH_PORT="${SYNC_HUB_SSH_PORT:-$VPS_SSH_PORT}"
    SERVER_PUBKEY="$(cat "$CDIR/.sync_hub_pubkey")"
    rm -f "$CDIR/.sync_result" "$CDIR/.sync_hub_pubkey"
    log "Key exchange OK. Assigned reverse port: $VPS_PORT"
  else
    rm -f "$CDIR/.sync_result" "$CDIR/.sync_hub_pubkey" 2>/dev/null || true
    err "Key exchange failed (wrong code, operator declined, or server not in sync mode)."
    echo
    echo "==================================================================="
    echo " ROBOT PUBLIC KEY (add it manually on the hub: robot-hub > add):"
    echo "==================================================================="
    cat "$CDIR/id_ed25519.pub"
    echo "==================================================================="
    exit 1
  fi
else
  VPS_PORT=$(ask "VPS reverse port (must match the hub, e.g. 22001)")
  case "$VPS_PORT" in ''|*[!0-9]*) err "Reverse port must be numeric."; exit 1;; esac
  echo
  log "Paste the SERVER public key (hub_to_robot_ed25519.pub) shown by the hub."
  log "This lets the hub connect INTO this robot as '$ROBOT_USER' without a password."
  read -rp "Server public key: " SERVER_PUBKEY
  case "$SERVER_PUBKEY" in ssh-*) : ;; *) err "Not an SSH public key (must start with 'ssh-')."; exit 1;; esac
fi

HOME_DIR="$(getent passwd "$ROBOT_USER" | cut -d: -f6)"
GRP="$(id -gn "$ROBOT_USER")"
install -d -m 700 -o "$ROBOT_USER" -g "$GRP" "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
grep -qxF "$SERVER_PUBKEY" "$HOME_DIR/.ssh/authorized_keys" || echo "$SERVER_PUBKEY" >> "$HOME_DIR/.ssh/authorized_keys"
chown "$ROBOT_USER:$GRP" "$HOME_DIR/.ssh/authorized_keys"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"
log "Server key installed for user '$ROBOT_USER'."

# ------------------------------ config ------------------------------
cat > "$CDIR/tunnel.conf" <<CONF
VPS_HOST=$VPS_HOST
VPS_SSH_PORT=$VPS_SSH_PORT
VPS_PORT=$VPS_PORT
TUNNEL_USER=$TUNNEL_USER
ROBOT_NAME=$ROBOT_NAME
ROBOT_SN=$ROBOT_SN
ROBOT_USER=$ROBOT_USER
NOTES=$NOTES
CONF

# ------------------------------ tunnel runner ------------------------------
cat > "$BUILD/run-tunnel.sh" <<'RUN'
#!/bin/sh
set -e
. /config/tunnel.conf
# Volume may carry host permissions; ssh refuses a group/world-readable key.
chmod 600 /config/id_ed25519 2>/dev/null || true
touch /config/known_hosts
echo "Starting reverse tunnel: ${TUNNEL_USER}@${VPS_HOST}:${VPS_SSH_PORT}  ->  127.0.0.1:${VPS_PORT} => robot:22"
exec autossh -M 0 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=/config/known_hosts \
  -o IdentitiesOnly=yes \
  -i /config/id_ed25519 \
  -p "${VPS_SSH_PORT}" \
  -N \
  -R 127.0.0.1:${VPS_PORT}:127.0.0.1:22 \
  "${TUNNEL_USER}@${VPS_HOST}"
RUN

# ------------------------------ Dockerfile ------------------------------
cat > "$BUILD/Dockerfile" <<'DOCKER'
FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      autossh openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV AUTOSSH_GATETIME=0
COPY run-tunnel.sh /usr/local/bin/run-tunnel.sh
RUN chmod +x /usr/local/bin/run-tunnel.sh
ENTRYPOINT ["/usr/local/bin/run-tunnel.sh"]
DOCKER

# ------------------------------ build & run ------------------------------
log "Building image $IMAGE ..."
docker build -t "$IMAGE" "$BUILD"

log "Recreating container $CONTAINER ..."
docker rm -f "$CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  -v "$CDIR":/config \
  "$IMAGE"

# ------------------------------ done ------------------------------
echo
log "Client is up. Follow logs with:  docker logs -f $CONTAINER"
echo "You should see:  ${TUNNEL_USER}@${VPS_HOST}   (NOT hub@...)"
echo
echo "==================================================================="
echo " ROBOT PUBLIC KEY  --  on the hub run 'robot-hub' > add, and paste:"
echo "==================================================================="
cat "$CDIR/id_ed25519.pub"
echo "==================================================================="
echo " Robot name: $ROBOT_NAME   |   Reverse port: $VPS_PORT   |   User: $ROBOT_USER"
echo
echo " If logs show 'Permission denied (publickey)':"
echo "   the robot key above is not added on the hub, or the port differs."
