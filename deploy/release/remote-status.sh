# VPS, sólo lectura (se envía detrás de remote-lib.sh): estado en líneas clave=valor.
# Nunca imprime valores de .env.local (sólo un hash de las variables NEXT_PUBLIC_*).
# Uso: remote-status.sh [deploy-id]   (con deploy-id agrega el resultado de esa activación)

main() {
  local info active
  info="$(pm2_info)"
  case "$info" in
    error|ausente) echo "pm2_status=$info" ;;
    *) echo "pm2_status=$(cut -d' ' -f1 <<< "$info")"
       echo "pm2_restarts=$(cut -d' ' -f2 <<< "$info")"
       echo "pm2_cwd=$(cut -d' ' -f3 <<< "$info")" ;;
  esac
  if [ -L "$CURRENT" ]; then
    active="$(readlink -f "$CURRENT")"
    echo "active_target=$active"
    echo "active_build=$(cat "$active/.next/BUILD_ID" 2>/dev/null)"
    echo "active_sha=$(git -C "$active" rev-parse HEAD 2>/dev/null)"
  else
    echo "active_target=sin-enlace"
  fi
  echo "disk_free_mb=$(disk_free_mb)"
  echo "mem_available_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
  echo "public_env_hash=$(grep -E '^NEXT_PUBLIC_[A-Z0-9_]*=' "$ENV_FILE" 2>/dev/null | tr -d '\r' | sed -E 's/[[:space:]]+$//' | LC_ALL=C sort | sha256sum | cut -c1-16)"
  echo "local_home=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_BASE/" 2>/dev/null || echo ERR)"
  if [ -n "${1:-}" ]; then
    [[ "$1" =~ $DEPLOY_ID_RE ]] || { echo "switch_result=argumento-invalido"; return; }
    if grep -q "^id=$1 " "$LAST_SWITCH" 2>/dev/null; then
      echo "switch_result=$(sed -E 's/^id=[^ ]+ result=([^ ]+) .*/\1/' "$LAST_SWITCH")"
    else
      echo "switch_result=desconocido"
    fi
  fi
  if [ -e "$LOCK_FILE" ] && ! "$FLOCK" -n "$LOCK_FILE" true 2>/dev/null; then
    echo "switch_lock=tomado"
  else
    echo "switch_lock=libre"
  fi
  [ -f "$LAST_SWITCH" ] && echo "last_switch=$(cat "$LAST_SWITCH")"
  return 0
}

main "$@"
