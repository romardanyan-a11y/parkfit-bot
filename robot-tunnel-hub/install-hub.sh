#!/usr/bin/env bash
#
# install-hub.sh  --  ONE-SHOT installer for the Robot Tunnel Hub (server / VPS side).
#
# Run this once on your public-IP Linux server (as root):
#     sudo bash install-hub.sh
#
# It will:
#   - install Docker if missing
#   - build the `robot-tunnel-hub` image (sshd + whiptail menu)
#   - persist host keys + hub->robot key in /opt/robot-tunnel-hub/data (survive rebuilds)
#   - start the container with --restart unless-stopped
#   - install the `robot-hub` command on the host
#   - generate the hub->robot key and print the server public key to paste on robots
#
set -euo pipefail

# ------------------------------ config ------------------------------
HUB_PORT="${HUB_PORT:-2222}"
IMAGE="robot-tunnel-hub:latest"
CONTAINER="robot-tunnel-hub"
BASE="/opt/robot-tunnel-hub"
DATA="$BASE/data"
BUILD="$BASE/build"

log(){ printf '\033[1;32m[hub]\033[0m %s\n' "$*"; }
err(){ printf '\033[1;31m[hub] ERROR:\033[0m %s\n' "$*" >&2; }

[ "$(id -u)" = "0" ] || { err "Please run as root (sudo)."; exit 1; }

# ------------------------------ docker ------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found. Installing via get.docker.com ..."
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker 2>/dev/null || true

# ------------------------------ layout ------------------------------
log "Preparing $DATA ..."
mkdir -p "$DATA/ssh/host_keys" "$BUILD"
chmod 755 "$BASE" "$DATA" "$DATA/ssh"
[ -f "$DATA/registry.json" ] || echo '{}' > "$DATA/registry.json"
touch "$DATA/ssh/authorized_keys"
chown root:root "$DATA/ssh/authorized_keys"
chmod 644 "$DATA/ssh/authorized_keys"

# ------------------------------ sshd_config ------------------------------
cat > "$BUILD/sshd_config" <<'SSHD'
Port 2222
AddressFamily inet
HostKey /data/ssh/host_keys/ssh_host_ed25519_key
PidFile /run/sshd.pid

# Auth: keys only, only the tunnel user, no root, no passwords.
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin no
AllowUsers robot-tunnel
AuthorizedKeysFile /data/ssh/authorized_keys

# Forwarding: reverse (-R) only, bound to loopback, nothing else.
AllowTcpForwarding remote
GatewayPorts no
X11Forwarding no
AllowAgentForwarding no
PermitTunnel no
PermitUserRC no

# Reap dead robot tunnels quickly so their ports are freed for reconnect.
ClientAliveInterval 30
ClientAliveCountMax 3
TCPKeepAlive yes

LogLevel VERBOSE
SSHD

# ------------------------------ entrypoint ------------------------------
cat > "$BUILD/entrypoint.sh" <<'ENTRY'
#!/bin/sh
set -e
mkdir -p /run/sshd /data/ssh/host_keys

# Persistent host key: generated once, reused across image rebuilds
# (otherwise every rebuild breaks host-key verification on all robots).
if [ ! -f /data/ssh/host_keys/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -f /data/ssh/host_keys/ssh_host_ed25519_key -N "" -C hub-host
fi
chmod 600 /data/ssh/host_keys/ssh_host_ed25519_key
chmod 644 /data/ssh/host_keys/ssh_host_ed25519_key.pub

[ -f /data/registry.json ] || echo '{}' > /data/registry.json
touch /data/ssh/authorized_keys
chown root:root /data/ssh/authorized_keys
chmod 644 /data/ssh/authorized_keys

exec /usr/sbin/sshd -D -e
ENTRY

# ------------------------------ robot-hub menu ------------------------------
cat > "$BUILD/robot-hub" <<'ROBOTHUB'
#!/usr/bin/env bash
# robot-hub -- whiptail menu running inside the hub container.
set -uo pipefail

DATA=/data
SSH_DIR="$DATA/ssh"
REG="$SSH_DIR/../registry.json"
AUTH="$SSH_DIR/authorized_keys"
HKEY="$SSH_DIR/hub_to_robot_ed25519"
KNOWN="$SSH_DIR/known_hosts_robots"
BT=whiptail
HUB_SSH_PORT=2222
SYNC_PORT="${SYNC_PORT:-2223}"

mkdir -p "$SSH_DIR"
[ -f "$REG" ] || echo '{}' > "$REG"
touch "$AUTH" "$KNOWN"

# One-shot TCP bridge: accept one robot, print its request line to stdout,
# read one response line from stdin, send it back. Keeps registry logic in bash.
PYBRIDGE_SERVER="$(cat <<'PYEOF'
import socket, sys
port = int(sys.argv[1])
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", port))
srv.listen(1)
srv.settimeout(300)
try:
    conn, addr = srv.accept()
except socket.timeout:
    sys.stderr.write("no robot connected (timeout)\n"); sys.exit(2)
conn.settimeout(300)
f = conn.makefile("rwb", buffering=0)
line = f.readline()
if not line:
    sys.exit(3)
sys.stdout.buffer.write(line if line.endswith(b"\n") else line + b"\n")
sys.stdout.flush()
resp = sys.stdin.buffer.readline()
try:
    f.write(resp); f.flush()
except Exception:
    pass
conn.close()
PYEOF
)"

now(){ date -u +%FT%TZ; }
msg(){ $BT --title "$1" --msgbox "$2" 20 78; }
confirm(){ $BT --title "$1" --yesno "$2" 12 78; }
input(){ $BT --title "$1" --inputbox "$2" 11 78 "${3:-}" 3>&1 1>&2 2>&3; }

reg_write(){ local tmp; tmp="$(mktemp)"; cat > "$tmp" && mv "$tmp" "$REG"; }
jget(){ jq -r --arg n "$1" ".[\$n].$2" "$REG"; }

port_online(){ ss -H -tln "sport = :$1" 2>/dev/null | grep -q .; }
used_ports(){ jq -r '.[].port' "$REG" 2>/dev/null; }
next_port(){ local p=22001; while used_ports | grep -qx "$p" || port_online "$p"; do p=$((p+1)); done; echo "$p"; }

auth_remove_port(){ local tmp; tmp="$(mktemp)"; grep -v "permitlisten=\"127.0.0.1:$1\"" "$AUTH" > "$tmp" 2>/dev/null || true; mv "$tmp" "$AUTH"; chown root:root "$AUTH" 2>/dev/null || true; chmod 644 "$AUTH"; }
auth_add(){ # port key name
  auth_remove_port "$1"
  printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s" %s %s\n' "$1" "$2" "$3" >> "$AUTH"
  chown root:root "$AUTH" 2>/dev/null || true; chmod 644 "$AUTH"
}

add_robot(){
  local name sn port user notes key ts
  name=$(input "Add robot" "Robot name:") || return
  [ -n "$name" ] || { msg Error "Empty name."; return; }
  if jq -e --arg n "$name" 'has($n)' "$REG" >/dev/null; then msg Error "Robot '$name' already exists."; return; fi
  sn=$(input "Add robot" "Robot SN:") || return
  port=$(input "Add robot" "VPS reverse port:" "$(next_port)") || return
  case "$port" in ''|*[!0-9]*) msg Error "Port must be numeric."; return;; esac
  if used_ports | grep -qx "$port"; then msg Error "Port $port is already used."; return; fi
  user=$(input "Add robot" "Robot SSH/SFTP user (e.g. siasun, root, robot):" "robot") || return
  [ -n "$user" ] || { msg Error "Empty user."; return; }
  notes=$(input "Add robot" "Notes:") || return
  key=$(input "Add robot" "Robot public key (ssh-ed25519 AAAA...):") || return
  case "$key" in ssh-*) : ;; *) msg Error "Key must start with 'ssh-'."; return;; esac
  ts="$(now)"
  jq --arg n "$name" --arg sn "$sn" --argjson p "$port" --arg u "$user" \
     --arg no "$notes" --arg k "$key" --arg t "$ts" \
     '.[$n]={sn:$sn,port:$p,tunnel_user:"robot-tunnel",robot_user:$u,notes:$no,public_key:$k,created_at:$t,updated_at:$t}' \
     "$REG" | reg_write
  auth_add "$port" "$key" "$name"
  msg Added "Robot '$name' added.\nPort: $port\nUser: $user\n\nMake sure the robot container is running and its key matches."
}

dashboard(){
  local out="" name port mark
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    port=$(jget "$name" port)
    if port_online "$port"; then mark="*"; else mark=" "; fi
    out+="[$mark] $(printf '%-20s' "$name") port:$port  user:$(jget "$name" robot_user)\n"
  done < <(jq -r 'keys[]' "$REG")
  [ -n "$out" ] || out="(no robots registered)\n"
  $BT --title "Dashboard   ( * = online )" --msgbox "$(echo -e "$out")" 24 78
}

do_connect(){
  local name="$1" port user
  port=$(jget "$name" port); user=$(jget "$name" robot_user)
  [ -f "$HKEY" ] || { msg Error "Server key missing. Use main menu > server-key > generate."; return; }
  if ! port_online "$port"; then confirm Offline "Robot '$name' looks OFFLINE (no tunnel on 127.0.0.1:$port). Try anyway?" || return; fi
  clear
  echo ">> SSH to '$name' as $user via 127.0.0.1:$port  (type 'exit' or Ctrl-D to return)"
  ssh -i "$HKEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$KNOWN" -p "$port" "$user@127.0.0.1" || true
  echo; read -rp "Press Enter to return to the menu..." _
}

do_sftp(){
  local name="$1" port user
  port=$(jget "$name" port); user=$(jget "$name" robot_user)
  [ -f "$HKEY" ] || { msg Error "Server key missing. Use main menu > server-key > generate."; return; }
  if ! port_online "$port"; then confirm Offline "Robot '$name' looks OFFLINE. Try anyway?" || return; fi
  clear
  echo ">> SFTP to '$name' as $user via 127.0.0.1:$port  (type 'bye' to return)"
  sftp -i "$HKEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
       -o UserKnownHostsFile="$KNOWN" -o "Port=$port" "$user@127.0.0.1" || true
  echo; read -rp "Press Enter to return to the menu..." _
}

show_details(){
  local n="$1"
  msg "Details: $n" "$(jq -r --arg n "$n" '.[$n] | to_entries | map("\(.key): \(.value)") | .[]' "$REG")"
}

do_rename(){
  local old="$1" new
  new=$(input "Rename" "New name for '$old':" "$old") || return 1
  [ -n "$new" ] && [ "$new" != "$old" ] || return 1
  if jq -e --arg n "$new" 'has($n)' "$REG" >/dev/null; then msg Error "'$new' already exists."; return 1; fi
  jq --arg o "$old" --arg n "$new" --arg t "$(now)" \
     '.[$n]=(.[$o] + {updated_at:$t}) | del(.[$o])' "$REG" | reg_write
  local port key; port=$(jget "$new" port); key=$(jget "$new" public_key)
  auth_add "$port" "$key" "$new"
  msg Renamed "'$old' renamed to '$new'."
  return 0
}

edit_notes(){
  local n="$1" notes
  notes=$(input "Notes" "Notes for '$n':" "$(jget "$n" notes)") || return
  jq --arg n "$n" --arg no "$notes" --arg t "$(now)" '.[$n].notes=$no | .[$n].updated_at=$t' "$REG" | reg_write
  msg Notes "Notes updated."
}

show_key(){ msg "Public key: $1" "$(jget "$1" public_key)"; }

update_key(){
  local n="$1" port key
  port=$(jget "$n" port)
  msg "Current key: $n" "$(jget "$n" public_key)"
  key=$(input "Update key" "New robot public key (ssh-ed25519 ...):") || return
  case "$key" in ssh-*) : ;; *) msg Error "Key must start with 'ssh-'."; return;; esac
  auth_add "$port" "$key" "$n"
  jq --arg n "$n" --arg k "$key" --arg t "$(now)" '.[$n].public_key=$k | .[$n].updated_at=$t' "$REG" | reg_write
  msg Updated "Key for '$n' replaced (port $port unchanged)."
}

remove_robot(){
  local n="$1" port
  confirm Remove "Remove robot '$n' from the hub?" || return 1
  port=$(jget "$n" port)
  auth_remove_port "$port"
  jq --arg n "$n" 'del(.[$n])' "$REG" | reg_write
  msg Removed "Robot '$n' removed."
  return 0
}

robot_card(){
  local name="$1" act port user
  while true; do
    port=$(jget "$name" port); user=$(jget "$name" robot_user)
    act=$($BT --title "Robot: $name" --menu "port:$port  user:$user  tunnel_user:robot-tunnel" 22 78 11 \
      connect    "SSH into the robot" \
      sftp       "SFTP into the robot" \
      details    "Show all fields" \
      rename     "Rename robot" \
      notes      "Edit notes" \
      show-key   "Show robot public key" \
      update-key "Replace robot public key" \
      remove     "Remove robot" \
      back       "Back to main menu" 3>&1 1>&2 2>&3) || return
    case "$act" in
      connect) do_connect "$name";;
      sftp) do_sftp "$name";;
      details) show_details "$name";;
      rename) do_rename "$name" && return;;
      notes) edit_notes "$name";;
      show-key) show_key "$name";;
      update-key) update_key "$name";;
      remove) remove_robot "$name" && return;;
      back|*) return;;
    esac
  done
}

select_robot(){
  local items=() name port mark choice
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    port=$(jget "$name" port); mark=" "; port_online "$port" && mark="*"
    items+=("$name" "[$mark] port:$port user:$(jget "$name" robot_user)")
  done < <(jq -r 'keys[]' "$REG")
  [ ${#items[@]} -gt 0 ] || { msg Select "No robots registered yet. Use 'add' first."; return; }
  choice=$($BT --title "Select robot" --menu "Choose a robot:" 22 78 12 "${items[@]}" 3>&1 1>&2 2>&3) || return
  robot_card "$choice"
}

server_key(){
  local act
  while true; do
    local state="MISSING"; [ -f "$HKEY" ] && state="present"
    act=$($BT --title "Server key (hub -> robot)  [$state]" --menu "hub_to_robot_ed25519" 18 78 6 \
      show     "Show server public key" \
      generate "Generate key if missing" \
      recreate "Recreate key (invalidates robots!)" \
      delete   "Delete key" \
      back     "Back" 3>&1 1>&2 2>&3) || return
    case "$act" in
      show) [ -f "$HKEY.pub" ] && msg "Server public key" "$(cat "$HKEY.pub")" || msg Error "No key yet. Use generate.";;
      generate)
        if [ -f "$HKEY" ]; then msg Info "Key already exists.";
        else ssh-keygen -q -t ed25519 -f "$HKEY" -N "" -C hub-to-robot; msg Generated "Add this public key to each robot user's authorized_keys:\n\n$(cat "$HKEY.pub")"; fi;;
      recreate)
        confirm Recreate "This creates a NEW key. Every robot must add the new public key or 'connect' will ask for a password. Continue?" || continue
        rm -f "$HKEY" "$HKEY.pub"; ssh-keygen -q -t ed25519 -f "$HKEY" -N "" -C hub-to-robot
        msg Recreated "New server public key (re-add on ALL robots):\n\n$(cat "$HKEY.pub")";;
      delete) confirm Delete "Delete the server key?" && rm -f "$HKEY" "$HKEY.pub" && msg Deleted "Server key removed.";;
      back|*) return;;
    esac
  done
}

ensure_hub_key(){ [ -f "$HKEY" ] || ssh-keygen -q -t ed25519 -f "$HKEY" -N "" -C hub-to-robot; }

print_keys_fallback(){ # $1 = robot pubkey (optional)
  clear
  echo "==================== SSH KEYS (manual fallback) ===================="
  echo "HUB public key (hub_to_robot_ed25519.pub) - install on the robot user:"
  [ -f "$HKEY.pub" ] && cat "$HKEY.pub" || echo "(none)"
  if [ -n "${1:-}" ]; then
    echo
    echo "ROBOT public key (from this pairing attempt):"
    echo "$1"
  fi
  echo "===================================================================="
  read -rp "Press Enter to return to the menu..." _
}

sync_mode(){
  ensure_hub_key
  local code; code=$(printf '%06d' $(( ( (RANDOM<<15) | RANDOM ) % 1000000 )))
  $BT --title "Synchronization mode" --msgbox \
"Pairing code for the robot:

        $code

Listening on TCP $SYNC_PORT for ONE robot (up to 5 min).
Make sure $SYNC_PORT/tcp is reachable (firewall).

On the robot: run setup, choose 'sync', enter this server's
IP and the code above. Press OK to start listening." 20 74 || return

  clear
  echo "[sync] Listening on 0.0.0.0:$SYNC_PORT  code=$code  (waiting for robot)"
  local req
  coproc BR { python3 -c "$PYBRIDGE_SERVER" "$SYNC_PORT" 2>/tmp/sync.err; }
  if ! IFS= read -r -t 320 req <&"${BR[0]}"; then
    kill "$BR_PID" 2>/dev/null || true; wait "$BR_PID" 2>/dev/null || true
    msg "Sync failed" "No robot connected, or the port is busy.\n\n$(cat /tmp/sync.err 2>/dev/null)"
    print_keys_fallback ""; return
  fi

  local rcode rname rsn ruser rnotes rkey
  rcode=$(printf '%s' "$req" | jq -r '.code   // ""' 2>/dev/null)
  rname=$(printf '%s' "$req" | jq -r '.name   // ""' 2>/dev/null)
  rsn=$(  printf '%s' "$req" | jq -r '.sn     // ""' 2>/dev/null)
  ruser=$(printf '%s' "$req" | jq -r '.robot_user // ""' 2>/dev/null)
  rnotes=$(printf '%s' "$req" | jq -r '.notes // ""' 2>/dev/null)
  rkey=$( printf '%s' "$req" | jq -r '.pubkey // ""' 2>/dev/null)

  send_resp(){ printf '%s\n' "$1" >&"${BR[1]}"; wait "$BR_PID" 2>/dev/null || true; }

  if [ "$rcode" != "$code" ]; then
    send_resp '{"status":"rejected","reason":"bad code"}'
    msg "Sync rejected" "Wrong pairing code from '$rname'. Nothing was added."
    print_keys_fallback "$rkey"; return
  fi
  case "$rkey" in ssh-*) : ;; *)
    send_resp '{"status":"rejected","reason":"bad key"}'
    msg "Sync failed" "Robot sent an invalid public key."
    print_keys_fallback "$rkey"; return;; esac

  if ! confirm "Approve robot?" "A robot wants to pair:

Name:  $rname
SN:    $rsn
User:  $ruser
Notes: $rnotes
Key:   ${rkey:0:38}...

Approve and exchange SSH keys?"; then
    send_resp '{"status":"rejected","reason":"operator declined"}'
    msg "Sync rejected" "You declined pairing with '$rname'. Nothing was added."
    print_keys_fallback "$rkey"; return
  fi

  # Resolve name collision, assign a free port, register, authorize.
  local base="$rname" i=1
  [ -n "$rname" ] || { rname="robot"; base="robot"; }
  while jq -e --arg n "$rname" 'has($n)' "$REG" >/dev/null; do rname="${base}-$i"; i=$((i+1)); done
  [ -n "$ruser" ] || ruser="robot"
  local newport ts hubpub resp
  newport=$(next_port); ts=$(now); hubpub=$(cat "$HKEY.pub")
  jq --arg n "$rname" --arg sn "$rsn" --argjson p "$newport" --arg u "$ruser" \
     --arg no "$rnotes" --arg k "$rkey" --arg t "$ts" \
     '.[$n]={sn:$sn,port:$p,tunnel_user:"robot-tunnel",robot_user:$u,notes:$no,public_key:$k,created_at:$t,updated_at:$t}' \
     "$REG" | reg_write
  auth_add "$newport" "$rkey" "$rname"
  resp=$(jq -cn --arg s ok --argjson p "$newport" --argjson sp "$HUB_SSH_PORT" --arg k "$hubpub" \
     '{status:$s,port:$p,hub_ssh_port:$sp,hub_pubkey:$k}')
  send_resp "$resp"
  msg "Sync OK" "Paired '$rname' on port $newport.\nSSH keys exchanged. The robot should come online shortly."
  print_keys_fallback "$rkey"
}

main_menu(){
  local c
  while true; do
    c=$($BT --title "Robot Tunnel Hub" --menu "Main menu" 21 76 9 \
      dashboard  "List robots (online/offline)" \
      select     "Select a robot and act on it" \
      add        "Add a robot (manual)" \
      sync       "Synchronization mode (auto key exchange)" \
      server-key "Manage hub->robot server key" \
      authorized "Show authorized_keys" \
      raw        "Show registry.json" \
      exit       "Quit" 3>&1 1>&2 2>&3) || exit 0
    case "$c" in
      dashboard) dashboard;;
      select) select_robot;;
      add) add_robot;;
      sync) sync_mode;;
      server-key) server_key;;
      authorized) msg "authorized_keys" "$(cat "$AUTH")";;
      raw) msg "registry.json" "$(jq . "$REG")";;
      exit|*) clear; exit 0;;
    esac
  done
}

main_menu
ROBOTHUB

# ------------------------------ Dockerfile ------------------------------
cat > "$BUILD/Dockerfile" <<'DOCKER'
FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server openssh-client whiptail jq iproute2 python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd -m -s /usr/sbin/nologin robot-tunnel
COPY sshd_config      /etc/ssh/sshd_config
COPY robot-hub        /usr/local/bin/robot-hub
COPY entrypoint.sh    /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/robot-hub /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
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
  -v "$DATA":/data \
  "$IMAGE"

# ------------------------------ host wrapper ------------------------------
cat > /usr/local/bin/robot-hub <<'WRAP'
#!/bin/sh
exec docker exec -it robot-tunnel-hub robot-hub
WRAP
chmod +x /usr/local/bin/robot-hub

# ------------------------------ server key ------------------------------
log "Ensuring hub->robot server key exists ..."
docker exec "$CONTAINER" sh -c '[ -f /data/ssh/hub_to_robot_ed25519 ] || ssh-keygen -q -t ed25519 -f /data/ssh/hub_to_robot_ed25519 -N "" -C hub-to-robot'

echo
log "Hub is up. sshd listening on port $HUB_PORT."
echo "-------------------------------------------------------------------"
echo " Open the menu any time with:   robot-hub"
echo
echo " SERVER PUBLIC KEY (paste this when running setup on each robot):"
echo "-------------------------------------------------------------------"
docker exec "$CONTAINER" cat /data/ssh/hub_to_robot_ed25519.pub
echo "-------------------------------------------------------------------"
echo
echo " Firewall reminder: allow ${HUB_PORT}/tcp always, and 2223/tcp while pairing."
echo " (2223 is the synchronization port; you may keep it closed and open it"
echo "  only when using 'robot-hub' > sync.)"
echo " Do NOT open robot ports (22001, 22002, ...) - they stay on 127.0.0.1."
echo
echo " Quick check:  ss -tlnp | grep -E '${HUB_PORT}|2200'"
