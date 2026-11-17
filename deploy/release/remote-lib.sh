#!/usr/bin/env bash
# Base común de los scripts del VPS. deploy.sh la envía por SSH concatenada DELANTE de cada
# script remoto (nada queda instalado en el servidor). Cada script termina con `main "$@"`:
# bash no ejecuta nada hasta leer el script completo, así que un envío cortado por la red falla
# con error de sintaxis sin haber tocado nada.
set -uo pipefail
umask 027
# Si se corta la conexión SSH, el script sigue hasta terminar (o revertir) en vez de morir a mitad.
trap '' HUP PIPE

if [ "${BEYONIX_DEPLOY_SANDBOX:-}" = 1 ]; then
  # Sólo para las pruebas aisladas (deploy/release/tests): nunca se activa en un despliegue real
  # (deploy.sh no envía variables de entorno) y se niega a correr fuera de /tmp.
  SANDBOX="${BEYONIX_SANDBOX_ROOT:-}"
  case "$SANDBOX" in
    /tmp/beyonix-deploy-sandbox.*) ;;
    *) echo "DETENER: sandbox fuera de /tmp/beyonix-deploy-sandbox.*"; exit 9 ;;
  esac
  APPS="$SANDBOX/apps"
  PM2="$SANDBOX/bin/pm2"
  CURL="$SANDBOX/bin/curl"
  NPM_BIN="$SANDBOX/bin/npm"
  ROLLBACK_DIR="$SANDBOX/rollback"
  PM2_DUMP="$SANDBOX/pm2/dump.pm2"
  PM2_ERROR_LOG="$SANDBOX/pm2/beyonix-error.log"
  HEALTH_BASE=http://sandbox.invalid:3000
  PUBLIC_URL=http://sandbox.invalid/
  HEALTH_TRIES="${BEYONIX_SANDBOX_HEALTH_TRIES:-2}"
  STABILITY_SECONDS="${BEYONIX_SANDBOX_STABILITY:-1}"
  NPM_CI_MEMORY_MAX="${BEYONIX_SANDBOX_NPM_MEMORY:-1200M}"
  NPM_CI_MIN_AVAILABLE_MB="${BEYONIX_SANDBOX_NPM_MIN_MB:-1500}"
else
  APPS=/home/beyonix/apps
  PM2=pm2
  CURL=curl
  NPM_BIN=npm
  ROLLBACK_DIR="$HOME/rollback"
  PM2_DUMP="$HOME/.pm2/dump.pm2"
  PM2_ERROR_LOG="$HOME/.pm2/logs/beyonix-error.log"
  HEALTH_BASE=http://127.0.0.1:3000
  PUBLIC_URL=https://beyonix.com.ar/
  HEALTH_TRIES=60
  STABILITY_SECONDS=60
  NPM_CI_MEMORY_MAX=1200M
  NPM_CI_MIN_AVAILABLE_MB=1500
fi

REL_ROOT="$APPS/beyonix-releases"
CURRENT="$APPS/beyonix-current"
ENV_FILE="$APPS/beyonix/.env.local"
HISTORY="$REL_ROOT/.deploy-history"
LAST_SWITCH="$REL_ROOT/.last-switch"
LOCK_FILE="$REL_ROOT/.switch.lock"
RUN_LOG=/dev/null
RELEASE_NAME_RE='^[0-9a-f]{7}-[0-9]{8}-[0-9]{6}$'
DEPLOY_ID_RE='^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$'

# Salida a la consola de quien llama y al log del VPS; nunca falla aunque la conexión se haya cortado.
say() {
  printf '%s\n' "$*" >> "$RUN_LOG" 2>/dev/null
  printf '%s\n' "$*" 2>/dev/null || true
}
stop() { say "DETENER: $*"; exit 1; }

open_run_log() { # open_run_log <deploy-id> <tipo>
  mkdir -p "$REL_ROOT/.deploy-logs" 2>/dev/null
  RUN_LOG="$REL_ROOT/.deploy-logs/$1-$2.log"
  : >> "$RUN_LOG" 2>/dev/null || RUN_LOG=/dev/null
}

# Bloqueo de cambios de versión: lo libera el sistema al terminar el proceso, pase lo que pase.
acquire_switch_lock() {
  exec 9>"$LOCK_FILE" || return 1
  flock -n 9
}

write_result() { # write_result <deploy-id> <resultado> <detalle>
  printf 'id=%s result=%s at=%s detail=%s\n' "$1" "$2" "$(date -Is)" "$3" > "$LAST_SWITCH.tmp.$$" \
    && mv -f "$LAST_SWITCH.tmp.$$" "$LAST_SWITCH"
}

# "status restarts cwd" del proceso beyonix; "ausente" si no existe; "error" si PM2 no responde.
pm2_info() {
  local json
  json="$("$PM2" jlist 2>/dev/null)" || { echo error; return; }
  node -e '
    let p; try { p = JSON.parse(require("fs").readFileSync(0, "utf8")).find(x => x.name === "beyonix") } catch { console.log("error"); process.exit(0) }
    console.log(p ? [p.pm2_env.status, p.pm2_env.restart_time, p.pm2_env.pm_cwd].join(" ") : "ausente")' <<< "$json"
}
pm2_status() { pm2_info | cut -d' ' -f1; }
pm2_restarts() { pm2_info | cut -d' ' -f2; }
pm2_cwd() { pm2_info | cut -d' ' -f3; }

# Salud: GET / responde 200 sirviendo el BUILD_ID esperado Y PM2 informa el proceso online.
health() { # health <build-id>
  local tmp code i
  tmp="$(mktemp)"
  for ((i = 0; i < HEALTH_TRIES; i++)); do
    code="$("$CURL" -s -o "$tmp" -w '%{http_code}' --max-time 5 "$HEALTH_BASE/" 2>/dev/null)" || code=000
    if [ "$code" = 200 ] && grep -qF "$1" "$tmp" && [ "$(pm2_status)" = online ]; then
      rm -f "$tmp"; return 0
    fi
    sleep 1
  done
  rm -f "$tmp"
  return 1
}

point_current() { # cambio atómico del enlace
  local tmp="$CURRENT.tmp.$$"
  rm -f "$tmp"
  ln -s "$1" "$tmp" || return 1
  mv -T "$tmp" "$CURRENT" || { rm -f "$tmp"; return 1; }
  [ "$(readlink -f "$CURRENT")" = "$1" ]
}

# Reinicia el proceso; si PM2 ya no lo tiene registrado, lo vuelve a crear con la configuración del sistema de releases.
restart_service() {
  "$PM2" restart beyonix >/dev/null 2>&1 && return 0
  if [ "$(pm2_status)" = ausente ]; then
    "$PM2" start npm --name beyonix --cwd "$CURRENT" -- start -- -H 127.0.0.1 -p 3000 >/dev/null 2>&1 && return 0
  fi
  return 1
}

# Vuelve el enlace a <ruta> y recupera el servicio; 0 sólo si quedó sano sirviendo <build-id>.
recover_to() { # recover_to <ruta> <build-id>
  point_current "$1" || { say "no se pudo restaurar el enlace a $1"; return 1; }
  restart_service || say "pm2 restart falló durante la recuperación"
  health "$2"
}

# Release completa y verificada. Imprime la ruta real; si no, deja el motivo en INVALID_REASON.
INVALID_REASON=""
validate_release() { # validate_release <ruta>
  local path name info_sha info_build manifest
  INVALID_REASON=""
  path="$(realpath -e -- "$1" 2>/dev/null)" || { INVALID_REASON="no existe"; return 1; }
  name="${path##*/}"
  [ "${path%/*}" = "$REL_ROOT" ] && [[ "$name" =~ $RELEASE_NAME_RE ]] || { INVALID_REASON="no es una release de $REL_ROOT"; return 1; }
  [ -f "$path/.release-info" ] || { INVALID_REASON="sin .release-info (nunca se verificó)"; return 1; }
  info_sha="$(sed -n 's/^sha=//p' "$path/.release-info")"
  info_build="$(sed -n 's/^build_id=//p' "$path/.release-info")"
  [[ "$info_sha" =~ ^[0-9a-f]{40}$ ]] && [ -n "$info_build" ] || { INVALID_REASON=".release-info incompleto"; return 1; }
  [ "$(cat "$path/.next/BUILD_ID" 2>/dev/null)" = "$info_build" ] || { INVALID_REASON="BUILD_ID no coincide con .release-info"; return 1; }
  [ "$(git -C "$path" rev-parse HEAD 2>/dev/null)" = "$info_sha" ] || { INVALID_REASON="el código no corresponde al commit registrado"; return 1; }
  [ -L "$path/.env.local" ] && [ -r "$path/.env.local" ] || { INVALID_REASON=".env.local ausente"; return 1; }
  (cd "$path" && node -e 'require.resolve("next/package.json"); require("sharp")' >/dev/null 2>&1) \
    || { INVALID_REASON="dependencias incompletas (next/sharp)"; return 1; }
  manifest="$path/.next-files.sha256"
  if [ ! -f "$manifest" ]; then
    # Releases anteriores a este sistema: el manifest quedó en su incoming (mismo build_id).
    manifest="$(grep -lx "build_id=$info_build" "$REL_ROOT"/incoming-*/meta.env 2>/dev/null | sed -n 1p)"
    manifest="${manifest%/meta.env}/next-files.sha256"
  fi
  [ -f "$manifest" ] || { INVALID_REASON="sin manifest de integridad"; return 1; }
  (cd "$path" && sha256sum -c --quiet "$manifest" >/dev/null 2>&1) || { INVALID_REASON="archivos del build alterados o faltantes"; return 1; }
  printf '%s\n' "$path"
}
