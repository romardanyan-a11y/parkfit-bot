#!/usr/bin/env bash
#
# robot-sync.sh  --  fast re-sync for a robot that was already set up once.
#
# Reuses the details saved by setup-robot-tunnel-client.sh (name, SN, user, VPS host).
# Asks only for the pairing port and the code, then exchanges keys and (re)starts
# the tunnel container. Run it whenever a sync attempt failed (e.g. the server was
# not in sync mode yet):
#     sudo bash robot-sync.sh
#
set -euo pipefail

TUNNEL_USER="robot-tunnel"
IMAGE="robot-tunnel-client:latest"
CONTAINER="robot-tunnel-client"
CDIR="/opt/robot-tunnel-client"
BUILD="$CDIR/build"

log(){ printf '\033[1;36m[robot]\033[0m %s\n' "$*"; }
err(){ printf '\033[1;31m[robot] ERROR:\033[0m %s\n' "$*" >&2; }
ask(){ local p="$1" d="${2:-}" a; if [ -n "$d" ]; then read -rp "$p [$d]: " a; echo "${a:-$d}"; else read -rp "$p: " a; echo "$a"; fi; }

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

[ "$(id -u)" = "0" ] || { err "Please run as root (sudo)."; exit 1; }

# ------------------------------ load saved details ------------------------------
[ -f "$CDIR/robot.conf" ] || { err "No saved details at $CDIR/robot.conf. Run setup-robot-tunnel-client.sh first."; exit 1; }
# shellcheck disable=SC1091
. "$CDIR/robot.conf"
: "${ROBOT_NAME:?}" "${ROBOT_USER:?}" "${VPS_HOST:?}" "${VPS_SSH_PORT:?}"
[ -f "$CDIR/id_ed25519.pub" ] || { err "Robot key missing. Run setup-robot-tunnel-client.sh first."; exit 1; }
chmod 600 "$CDIR/id_ed25519" 2>/dev/null || true
touch "$CDIR/known_hosts"
getent passwd "$ROBOT_USER" >/dev/null || { err "User '$ROBOT_USER' does not exist."; exit 1; }

log "Robot: $ROBOT_NAME (user: $ROBOT_USER)  ->  $VPS_HOST"
command -v python3 >/dev/null 2>&1 || { apt-get install -y python3 2>/dev/null || true; }
command -v python3 >/dev/null 2>&1 || { err "python3 not available."; exit 1; }

# ------------------------------ exchange ------------------------------
PAIR_PORT=$(ask "Server pairing port" "2223")
CODE=$(ask "Pairing code shown on the server (sync mode)")
echo
log "Contacting $VPS_HOST:$PAIR_PORT for key exchange (approve on the server) ..."
if ! python3 -c "$PYCLIENT" "$VPS_HOST" "$PAIR_PORT" "$CODE" \
     "$ROBOT_NAME" "${ROBOT_SN:-}" "$ROBOT_USER" "${NOTES:-}" "$(cat "$CDIR/id_ed25519.pub")" "$CDIR"; then
  rm -f "$CDIR/.sync_result" "$CDIR/.sync_hub_pubkey" 2>/dev/null || true
  err "Key exchange failed (wrong code, operator declined, or server not in sync mode)."
  echo "==================================================================="
  echo " ROBOT PUBLIC KEY (add manually on the hub: robot-hub > add):"
  echo "==================================================================="
  cat "$CDIR/id_ed25519.pub"
  echo "==================================================================="
  exit 1
fi
# shellcheck disable=SC1091
. "$CDIR/.sync_result"
VPS_PORT="$SYNC_PORT"
VPS_SSH_PORT="${SYNC_HUB_SSH_PORT:-$VPS_SSH_PORT}"
SERVER_PUBKEY="$(cat "$CDIR/.sync_hub_pubkey")"
rm -f "$CDIR/.sync_result" "$CDIR/.sync_hub_pubkey"
log "Key exchange OK. Assigned reverse port: $VPS_PORT"

# ------------------------------ install hub key into robot user ------------------------------
HOME_DIR="$(getent passwd "$ROBOT_USER" | cut -d: -f6)"
GRP="$(id -gn "$ROBOT_USER")"
install -d -m 700 -o "$ROBOT_USER" -g "$GRP" "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
grep -qxF "$SERVER_PUBKEY" "$HOME_DIR/.ssh/authorized_keys" || echo "$SERVER_PUBKEY" >> "$HOME_DIR/.ssh/authorized_keys"
chown "$ROBOT_USER:$GRP" "$HOME_DIR/.ssh/authorized_keys"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"

# ------------------------------ write config ------------------------------
cat > "$CDIR/tunnel.conf" <<CONF
VPS_HOST=$VPS_HOST
VPS_SSH_PORT=$VPS_SSH_PORT
VPS_PORT=$VPS_PORT
TUNNEL_USER=$TUNNEL_USER
ROBOT_NAME=$ROBOT_NAME
ROBOT_SN=${ROBOT_SN:-}
ROBOT_USER=$ROBOT_USER
NOTES=${NOTES:-}
CONF

# ------------------------------ (re)build our image, always ------------------------------
# Always rebuild so a stale/foreign robot-tunnel-client image can never be reused.
mkdir -p "$BUILD"
cat > "$BUILD/run-tunnel.sh" <<'RUN'
#!/bin/sh
set -e
. /config/tunnel.conf
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
log "Building image $IMAGE ..."
docker build -t "$IMAGE" "$BUILD"

log "Recreating container $CONTAINER ..."
docker rm -f "$CONTAINER" 2>/dev/null || true
docker run -d --name "$CONTAINER" --restart unless-stopped --network host -v "$CDIR":/config "$IMAGE"

echo
log "Done. Follow logs:  docker logs -f $CONTAINER"
echo "You should see:  ${TUNNEL_USER}@${VPS_HOST}"
echo "==================================================================="
echo " ROBOT PUBLIC KEY:"; cat "$CDIR/id_ed25519.pub"
echo "==================================================================="
