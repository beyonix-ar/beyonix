#!/usr/bin/env bash
# Orquestador de despliegue de BEYONIX (PC Windows, Git Bash). Lo invoca deploy-beyonix.ps1.
#   bash deploy.sh                      despliegue completo
#   bash deploy.sh --solo-preparar      todo menos la activación (no reinicia nada)
#   bash deploy.sh --rollback [release] vuelve a la versión anterior ya compilada
#   bash deploy.sh --estado             muestra la versión activa y el último cambio (sólo lectura)
#   Validación estándar (por defecto): ESLint + TypeScript. npm test NO se ejecuta.
#   --validacion-completa (con despliegue o --solo-preparar): ESLint + TypeScript + npm test, siempre
#   ejecutados (no reutiliza aprobaciones previas).
# Nunca aplica migraciones, nunca toca variables de entorno, la base de datos ni los timers.
# En consola sólo muestra pasos simples; el detalle completo queda en el log.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

MODE=desplegar
ROLLBACK_TARGET=-
FORCE_VALIDATION=0
usage() { echo "uso: deploy.sh [--solo-preparar] [--validacion-completa] | --estado | --rollback [release]"; exit 2; }
if [ "${1:-}" = --validacion-completa ]; then FORCE_VALIDATION=1; shift; fi
case "${1:-}" in
  "") ;;
  --solo-preparar) MODE=preparar
    [ "${2:-}" = --validacion-completa ] && { FORCE_VALIDATION=1; shift; }
    [ $# -le 1 ] || usage ;;
  --estado) MODE=estado; [ $# = 1 ] && [ "$FORCE_VALIDATION" = 0 ] || usage ;;
  --rollback)
    MODE=rollback
    [ $# -le 2 ] && [ "$FORCE_VALIDATION" = 0 ] || usage
    if [ -n "${2:-}" ]; then
      ROLLBACK_TARGET="$(normalize_release_arg "$2")" \
        || { echo "Error: versión inválida. Usá el nombre de una release (p. ej. ac1fe04-20261116-132041)."; exit 2; }
    fi ;;
  *) usage ;;
esac
VALIDATION_LEVEL=estandar
[ "$FORCE_VALIDATION" = 1 ] && VALIDATION_LEVEL=completa
VALIDATION_DONE=""
# BEYONIX_DEPLOY_REPO sólo para probar estos scripts contra otro checkout (p. ej. un worktree limpio).
REPO="${BEYONIX_DEPLOY_REPO:-$(git -C "$HERE" rev-parse --show-toplevel)}"
BASE="$(cygpath -u "$USERPROFILE")/Documents/BEYONIX-backups"
LOG_DIR="$BASE/deploy-logs"
BUILD_DIR="$BASE/builds"
BUILD_ENV="$BASE/build-env"
APPROVALS="$BASE/deploy-approvals"
SITE=https://beyonix.com.ar
CURRENT=/home/beyonix/apps/beyonix-current
SSH_OPTS=(-i "$HOME/.ssh/beyonix_donweb_trabajo" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
SSH=(ssh "${SSH_OPTS[@]}" -p 5799 beyonix@168.181.186.203)
SCP=(scp -q "${SSH_OPTS[@]}" -P 5799)
VPS=beyonix@168.181.186.203
DEPLOY_ID="$(new_deploy_id)"

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"
: > "$LOG"
LOCK="$LOG_DIR/.deploy.lock"

log() { echo "[$(date +%T)] $*" >> "$LOG"; }
say() { echo "$*"; log "== $*"; }
winlog() { cygpath -w "$LOG"; }
# Último resguardo: enmascara cualquier credencial que una herramienta haya escrito en el log.
redact_log() {
  sed -i -E \
    -e 's/(re_[A-Za-z0-9]{4})[A-Za-z0-9_]+/\1***/g' \
    -e 's/(Bearer )[A-Za-z0-9._~+\/=-]+/\1***/g' \
    -e 's/(eyJ[A-Za-z0-9_-]{4})[A-Za-z0-9._-]+/\1***/g' \
    -e 's/((APP_USR|TEST)-[0-9]{4})[A-Za-z0-9-]+/\1***/g' \
    "$LOG" 2>/dev/null || true
}
# Tiempos por etapa: "tiempo <clave>=<ms>" en el log y resumen al terminar (también si se detiene).
T_START=$(now_ms)
T_STAGE=$T_START
TIMES=()
add_time() { TIMES+=("$1 $2"); log "tiempo $1=$2"; }
t_begin() { T_STAGE=$(now_ms); }
t_end() { add_time "$1" $(( $(now_ms) - T_STAGE )); T_STAGE=$(now_ms); }
add_times_from() { # las líneas "tiempo <clave>=<ms>" que emiten local-build.sh y remote-assemble.sh
  local k v
  while read -r k v; do add_time "$k" "$v"; done < <(sed -nE 's/^tiempo ([a-z_]+)=([0-9]+)$/\1 \2/p' <<< "$1")
}
print_times() {
  local e k v line
  [ ${#TIMES[@]} -gt 0 ] || return 0
  echo "Tiempos:"
  for e in "${TIMES[@]}"; do
    k="${e% *}"; v="${e##* }"
    if [ "$k" = validaciones_reutilizadas_completa ]; then
      line="$(printf '  %-42s %s' "ESLint + TypeScript + Tests" "reutilizados (aprobación completa previa)")"
    elif [ "$k" = validaciones_reutilizadas_estandar ]; then
      line="$(printf '  %-42s %s' "ESLint + TypeScript" "reutilizados (aprobación estándar previa)")"
      echo "$line"; log "$line"
      line="$(printf '  %-42s %s' "Tests" "NO ejecutados (validación estándar)")"
    elif [ "$k" = tests_omitidos ]; then
      line="$(printf '  %-42s %s' "Tests" "NO ejecutados (validación estándar)")"
    else
      line="$(printf '  %-42s %10s' "$(stage_label "$k")" "$(fmt_ms "$v")")"
    fi
    echo "$line"; log "$line"
  done
  line="$(printf '  %-42s %10s' "Total" "$(fmt_ms $(( $(now_ms) - T_START )))")"
  echo "$line"; log "$line"
}
finish() {
  print_times
  rmdir "$LOCK" 2>/dev/null || true
  redact_log
}
# Error ANTES de tocar producción.
abort() {
  log "DETENER: $1"
  echo "Error: se conservó la versión anterior."
  echo "Motivo: $1"
  echo "Detalle: $(winlog)"
  exit 1
}
run() { log "\$ $*"; "$@" >> "$LOG" 2>&1; }
# Script remoto: remote-lib.sh + script, enviados por stdin (nada queda instalado en el VPS).
# Los argumentos pasan por la lista blanca de remote_command; salida en $OUT y en el log.
# Código 255 = falló la conexión SSH (los scripts nunca devuelven 255).
remote() {
  local script="$1" cmd rc; shift
  cmd="$(remote_command "$@")" || { log "argumento remoto rechazado: $*"; OUT="DETENER: argumento inválido"; return 2; }
  log "\$ ssh: $script $*"
  OUT="$(cat "$HERE/remote-lib.sh" "$HERE/$script" | tr -d '\r' | "${SSH[@]}" "$cmd" 2>&1)"
  rc=$?
  printf '%s\n' "$OUT" >> "$LOG"
  log "rc=$rc"
  return $rc
}
kv() { sed -n "s/^$1=//p" <<< "$2" | sed -n 1p; }
first_stop() { grep -E '^(DETENER|ALERTA)' <<< "$OUT" | sed -n 1p; }
fetch_status() { remote remote-status.sh "$1" && printf '%s\n' "$OUT"; }

mkdir "$LOCK" 2>/dev/null || { echo "Error: ya hay otro despliegue en curso en esta PC (si no es así, borrá $(cygpath -w "$LOCK"))."; exit 1; }
trap finish EXIT
log "modo=$MODE repo=$REPO deploy_id=$DEPLOY_ID"

# ───────────────────────── Estado (sólo lectura) ─────────────────────────
if [ "$MODE" = estado ]; then
  remote remote-status.sh || { echo "Error: no se pudo conectar con el VPS."; exit 1; }
  echo "BEYONIX: $(kv pm2_status "$OUT") · versión activa: $(basename "$(kv active_target "$OUT")") (build $(kv active_build "$OUT"))"
  last="$(kv last_switch "$OUT")"
  echo "Último cambio: ${last:-ninguno registrado con este sistema}"
  [ "$(kv switch_lock "$OUT")" = tomado ] && echo "Hay un cambio de versión en curso en este momento."
  exit 0
fi

# ───────────────────────── Rollback manual ─────────────────────────
if [ "$MODE" = rollback ]; then
  say "Volviendo a la versión anterior."
  remote remote-rollback.sh "$DEPLOY_ID" - "$ROLLBACK_TARGET"
  rc=$?
  case $rc in
    0|5)
      build="$(sed -n 's/^ROLLBACK OK build_id=\([^ ]*\).*/\1/p' <<< "$OUT")"
      pub=0
      for _ in $(seq 1 20); do
        curl -s --max-time 10 "$SITE/" | grep -qF "$build" && { pub=1; break; }
        sleep 3
      done
      [ "$pub" = 1 ] || { echo "Error: el VPS volvió a la versión anterior pero el sitio público no la confirma."; echo "Detalle: $(winlog)"; exit 1; }
      say "Versión anterior restaurada (build $build)."
      [ $rc = 5 ] && echo "Aviso: pm2 save falló; tras un reinicio del VPS revisar con pm2 list."
      echo "Detalle: $(winlog)"
      exit 0 ;;
    3) echo "Error: la versión destino no respondió; se mantuvo la versión que estaba." ;;
    4) echo "ALERTA CRÍTICA: BEYONIX puede estar caído. Revisar el VPS de inmediato (pm2 list / pm2 logs beyonix)." ;;
    255) echo "Error: se perdió la conexión con el VPS. Consultá el resultado con: .\\deploy-beyonix.ps1 -Estado" ;;
    *) echo "Error: no se pudo volver a la versión anterior. Motivo: $(first_stop)" ;;
  esac
  echo "Detalle: $(winlog)"
  exit 1
fi

# ───────────────────────── 1. Preparación ─────────────────────────
say "Preparando actualización."
t_begin

run git -C "$REPO" fetch --quiet origin main || abort "no se pudo consultar GitHub (origin/main)"
BRANCH="$(git -C "$REPO" symbolic-ref -q --short HEAD || echo "(sin rama)")"
if [ "$BRANCH" != main ]; then
  [ "$MODE" = preparar ] || abort "el repositorio no está en la rama main (está en $BRANCH)"
  log "AVISO: rama $BRANCH (permitido sólo en --solo-preparar)"
fi
dirty="$(git -C "$REPO" status --porcelain)"
[ -z "$dirty" ] || { log "cambios sin commit:"; log "$dirty"; abort "hay cambios sin commit en el repositorio"; }
SHA="$(git -C "$REPO" rev-parse HEAD)"
is_sha "$SHA" || abort "no se pudo leer el commit actual"
[ "$SHA" = "$(git -C "$REPO" rev-parse origin/main)" ] \
  || abort "el código local ($(git -C "$REPO" rev-parse --short HEAD)) no coincide con GitHub origin/main ($(git -C "$REPO" rev-parse --short origin/main)); hacé push o pull primero"
log "commit=$SHA ($(git -C "$REPO" log -1 --format=%s "$SHA"))"
t_end git

remote remote-status.sh || abort "no se pudo leer el estado del VPS"
STATUS="$OUT"
[ "$(kv pm2_status "$STATUS")" = online ] || abort "BEYONIX no está online en el VPS; revisar antes de desplegar"
[ "$(kv pm2_cwd "$STATUS")" = "$CURRENT" ] || abort "PM2 no usa el sistema de releases ($CURRENT)"
[ "$(kv local_home "$STATUS")" = 200 ] || abort "la versión activa no responde 200"
[ "$(kv switch_lock "$STATUS")" = libre ] || abort "hay otro cambio de versión en curso en el VPS"
ACTIVE="$(kv active_target "$STATUS")"
ACTIVE_BUILD="$(kv active_build "$STATUS")"
is_release_path "$ACTIVE" && [ -n "$ACTIVE_BUILD" ] || abort "no se pudo leer la versión activa"
[ "$(kv disk_free_mb "$STATUS")" -ge 4000 ] || abort "menos de 4 GB libres en el VPS (limpiar releases viejas manualmente)"
[ "$(kv mem_available_mb "$STATUS")" -ge 900 ] || abort "memoria insuficiente en el VPS para verificar la versión nueva"
ONLY_VALIDATE=0
if [ "$(kv active_sha "$STATUS")" = "$SHA" ]; then
  if [ "$MODE" = desplegar ] && [ "$VALIDATION_LEVEL" != completa ]; then
    say "BEYONIX ya tiene esta versión ($(git -C "$REPO" rev-parse --short HEAD)). No hay nada para actualizar."
    exit 0
  elif [ "$MODE" = desplegar ]; then
    # -ValidacionCompleta pedida sobre la versión activa: se valida (con npm test) y se termina sin
    # compilar, transferir ni activar nada.
    ONLY_VALIDATE=1
    log "AVISO: el commit ya está activo; sólo se ejecuta la validación completa (no se despliega)"
  else
    log "AVISO: el commit ya está activo; se prepara igual (--solo-preparar)"
  fi
fi
t_end vps

public_hash() { grep -E '^NEXT_PUBLIC_[A-Z0-9_]*=' "$1" | tr -d '\r' | sed -E 's/[[:space:]]+$//' | LC_ALL=C sort | sha256sum | cut -c1-16; }
[ -f "$REPO/.env.local" ] || abort "falta .env.local en el repositorio local"
[ "$(public_hash "$REPO/.env.local")" = "$(kv public_env_hash "$STATUS")" ] \
  || abort "las variables públicas (NEXT_PUBLIC_*) del .env.local local no coinciden con las de producción"
t_end variables

# Migraciones: sólo lectura. Formato pedido explícitamente (--agent no -o json) y validado.
MIG_TMP="$(mktemp -d)"
mkdir -p "$MIG_TMP/supabase"
cp -r "$REPO/supabase/.temp" "$MIG_TMP/supabase/.temp"
echo "select version from supabase_migrations.schema_migrations order by version;" > "$MIG_TMP/q.sql"
mig_out="$(cd "$MIG_TMP" && npx --prefix "$(cygpath -w "$REPO")" --no-install supabase db query --linked --agent no -o json \
  -f "$(cygpath -w "$MIG_TMP/q.sql")" 2>>"$LOG")"
mig_rc=$?
case "$MIG_TMP" in /tmp/tmp.*) rm -rf -- "$MIG_TMP" ;; esac
[ "$mig_rc" = 0 ] || abort "no se pudo consultar las migraciones aplicadas en producción (supabase rc=$mig_rc)"
remote_versions="$(parse_remote_migrations <<< "$mig_out" 2>>"$LOG" | tr -d '\r')" \
  || abort "respuesta de migraciones con formato inesperado; no se puede asegurar que no haya pendientes"
local_versions="$(local_migrations_of_commit "$REPO" "$SHA" 2>>"$LOG")" || abort "no se pudieron leer las migraciones del commit"
cmp_out="$(compare_migrations "$remote_versions" "$local_versions")"
pending="$(kv pendientes "$cmp_out")"
unknown="$(kv desconocidas "$cmp_out")"
log "migraciones remotas=$(wc -l <<< "$remote_versions") locales=$(wc -l <<< "$local_versions")"
[ -z "$pending" ] || abort "hay migraciones pendientes de aplicar en producción: $pending. Aplicalas manualmente (con backup) y volvé a ejecutar"
[ -z "$unknown" ] || abort "producción tiene migraciones que este commit no conoce: $unknown"
log "preparación OK commit=$SHA activa=$ACTIVE build_activo=$ACTIVE_BUILD"
t_end migraciones

# ───────────────────────── 2. Compilación ─────────────────────────
say "Compilando."
# Validaciones. Deploy normal: nivel estándar (lint + typecheck; npm test NO se ejecuta). Con
# --validacion-completa: lint + typecheck + npm test, siempre ejecutados (nunca se reutilizan).
# En el estándar se reutiliza una aprobación de ESTE commit (completa o estándar) sólo si coincide toda
# su identidad (árbol, contenido de dependencias, herramientas, .env.local, entorno, nivel).
BASE_IDENTITY="$(approval_base_identity "$REPO" "$SHA" 2>>"$LOG")" || BASE_IDENTITY=""
REUSED_LEVEL=""
if [ "$VALIDATION_LEVEL" = completa ]; then
  log "aprobación: validación completa solicitada (--validacion-completa) => se ejecutan lint, typecheck y npm test"
elif [ -z "$BASE_IDENTITY" ]; then
  log "aprobación: identidad indeterminada => validación estándar"
elif REUSED_LEVEL="$(approval_pick "$APPROVALS" "$SHA" "$BASE_IDENTITY" 2>"$LOG.motivos")"; then
  reused_file="$(approval_file "$APPROVALS" "$SHA" "$REUSED_LEVEL")"
  log "aprobación REUTILIZADA ($(validation_description "$REUSED_LEVEL")): $reused_file (aprobada el $(sed -n 's/^aprobado_en=//p' "$reused_file"); log de esa validación: $(sed -n 's/^log=//p' "$reused_file"))"
else
  REUSED_LEVEL=""
  log "aprobación: no reutilizable ($(tr '\n' ';' < "$LOG.motivos")) => validación estándar"
fi
rm -f -- "$LOG.motivos"
t_end aprobacion
if [ -n "$REUSED_LEVEL" ]; then
  VALIDATION_DONE="$(validation_description "$REUSED_LEVEL") — aprobación previa reutilizada"
  echo "Validaciones: se reutiliza la aprobación $(validation_description "$REUSED_LEVEL") de este mismo commit."
  add_time "validaciones_reutilizadas_$REUSED_LEVEL" 0
else
  if [ "$VALIDATION_LEVEL" = completa ]; then
    echo "Validaciones: completa (ESLint + TypeScript + npm test)."
  else
    echo "Validaciones: estándar (ESLint + TypeScript). npm test no se ejecuta; para incluirlo: -ValidacionCompleta."
  fi
  # Primero se invalidan TODOS los niveles del commit (todos dependen de lint y typecheck): una
  # validación fallida o interrumpida nunca deja una aprobación utilizable, tampoco una estándar previa.
  approval_revoke_all "$APPROVALS" "$SHA" || abort "no se pudieron invalidar las aprobaciones anteriores"
  VAL_OUT="$(validate_commit "$REPO" "$VALIDATION_LEVEL" "$LOG")"
  VAL_RC=$?
  add_times_from "$VAL_OUT"
  t_begin
  # Se aprueba sólo lo que ESTA ejecución demostró y sólo si la identidad (incluido el contenido de
  # node_modules) no cambió mientras se validaba: la aprobación corresponde a las dependencias usadas.
  if validation_passed_level estandar "$VAL_RC"; then
    AFTER_IDENTITY="$(approval_base_identity "$REPO" "$SHA" 2>/dev/null)" || AFTER_IDENTITY=""
    t_end integridad_aprobacion
    if saved="$(approval_record "$APPROVALS" "$SHA" "$VALIDATION_LEVEL" "$VAL_RC" "$BASE_IDENTITY" "$AFTER_IDENTITY" "$(winlog)")"; then
      log "aprobaciones guardadas: $(tr '\n' ' ' <<< "$saved")"
    else
      changed="$(diff <(printf '%s\n' "$BASE_IDENTITY") <(printf '%s\n' "$AFTER_IDENTITY") | sed -nE 's/^[<>] ([a-z_]+)=.*/\1/p' | sort -u | tr '\n' ' ')"
      log "AVISO: no se guarda aprobación: la identidad cambió o no se pudo recalcular durante la validación (${changed:-indeterminada}), o falló la escritura"
    fi
  fi
  case $VAL_RC in
    0) ;;
    10) abort "lint con errores" ;;
    11) abort "typecheck con errores" ;;
    124) abort "los tests superaron 90 minutos (se terminaron todos sus procesos)" ;;
    125) abort "los tests superaron 90 minutos y quedaron procesos sin terminar (ver log)" ;;
    12) abort "fallaron tests" ;;
    *) abort "no se pudieron ejecutar las validaciones (código $VAL_RC)" ;;
  esac
  [ "$VALIDATION_LEVEL" = completa ] || add_time tests_omitidos 0
  VALIDATION_DONE="$(validation_description "$VALIDATION_LEVEL") — ejecutada ahora"
fi
log "validación del commit: $VALIDATION_DONE"
if [ "$ONLY_VALIDATE" = 1 ]; then
  say "Validación completa terminada. BEYONIX ya tiene esta versión: no se compiló ni se desplegó nada."
  echo "Validación: $VALIDATION_DONE"
  echo "Detalle: $(winlog)"
  exit 0
fi

log "\$ local-build.sh $SHA (entorno $BUILD_ENV)"
BUILD_OUT="$(bash "$HERE/local-build.sh" "$SHA" "$REPO" "$BUILD_DIR" "$BUILD_ENV" 2>&1)"
BUILD_RC=$?
printf '%s\n' "$BUILD_OUT" >> "$LOG"
add_times_from "$BUILD_OUT"
t_begin
[ "$BUILD_RC" = 0 ] || abort "el build falló ($(grep -E '^DETENER' <<< "$BUILD_OUT" | sed -n 1p))"
ARTIFACT="$(sed -n 's/^LISTO artefacto=\([^ ]*\) .*/\1/p' <<< "$BUILD_OUT" | sed -n '$p')"
NEW_BUILD="$(sed -n 's/^LISTO artefacto=.* build_id=//p' <<< "$BUILD_OUT" | sed -n '$p')"
[ -d "$ARTIFACT" ] && [ -n "$NEW_BUILD" ] || abort "no se encontró el artefacto del build"

# ───────────────────────── 3. Transferencia ─────────────────────────
say "Transfiriendo."
INCOMING="$VPS_REL_ROOT/incoming-$(date +%Y%m%d-%H%M%S)"
is_incoming_path "$INCOMING" || abort "ruta de recepción inválida"
run "${SSH[@]}" "mkdir -m 700 $INCOMING" || abort "no se pudo crear el directorio de recepción en el VPS"
run "${SCP[@]}" "$ARTIFACT/next-build.tar.gz" "$ARTIFACT/next-files.sha256" "$ARTIFACT/meta.env" "$ARTIFACT/SHA256SUMS" "$VPS:$INCOMING/" \
  || abort "falló la transferencia al VPS"
t_end transferencia

# ───────────────────────── 4. Verificación ─────────────────────────
say "Verificando."
remote remote-assemble.sh "$SHA" "$INCOMING"
ASSEMBLE_RC=$?
add_times_from "$OUT"
t_begin
[ "$ASSEMBLE_RC" = 0 ] || abort "la versión nueva no pasó la verificación en el VPS ($(first_stop))"
RELEASE="$(sed -n 's/^LISTO release=\([^ ]*\) .*/\1/p' <<< "$OUT")"
is_release_path "$RELEASE" || abort "el VPS informó una release inválida"
[ "$(sed -n 's/^LISTO release=.* build_id=//p' <<< "$OUT")" = "$NEW_BUILD" ] || abort "la release armada no corresponde al build compilado"

if [ "$MODE" = preparar ]; then
  say "Versión preparada y verificada, SIN activar."
  echo "Validación: $VALIDATION_DONE"
  echo "Release: $(basename "$RELEASE") (build $NEW_BUILD)"
  echo "Detalle: $(winlog)"
  exit 0
fi

# ───────────────────────── 5. Activación ─────────────────────────
say "Actualizando BEYONIX."
t_begin
# Fuera de los disparos de los timers (segundo 0 de cada minuto; minutos múltiplos de 5).
for _ in $(seq 1 400); do
  s=$((10#$(date +%S))); m=$((10#$(date +%M) % 5))
  [ "$s" -ge 20 ] && [ "$s" -le 40 ] && [ "$m" != 0 ] && [ "$m" != 4 ] && break
  sleep 1
done
t_end ventana

# El VPS bloquea, comprueba que la activa siga siendo $ACTIVE, activa, verifica estabilidad y,
# si algo falla, vuelve solo a la anterior; todo bajo el mismo bloqueo.
remote remote-switch.sh "$RELEASE" "$ACTIVE" "$DEPLOY_ID"
SWITCH_RC=$?
t_end activacion
if [ "$SWITCH_RC" = 255 ]; then
  log "conexión perdida durante la activación; consultando el resultado"
  case "$(await_switch_result "$DEPLOY_ID" 40 15)" in
    ACTIVADA) SWITCH_RC=0 ;;
    ACTIVADA_SIN_SAVE) SWITCH_RC=5 ;;
    ROLLBACK_OK) SWITCH_RC=3 ;;
    CRITICO) SWITCH_RC=4 ;;
    *) echo "Error: se perdió la conexión con el VPS durante la activación. El VPS termina solo la activación o la reversión."
       echo "Consultá el resultado con: .\\deploy-beyonix.ps1 -Estado"
       echo "Detalle: $(winlog)"; exit 2 ;;
  esac
fi
case "$SWITCH_RC" in
  0|5) ;;
  3) echo "Error: se recuperó la versión anterior (la nueva falló: $(sed -n 's/^ROLLBACK: //p' <<< "$OUT" | sed -n 1p))."
     echo "Detalle: $(winlog)"; exit 1 ;;
  4) echo "ALERTA CRÍTICA: la versión nueva falló y la anterior no respondió. BEYONIX puede estar caído."
     echo "Revisar el VPS de inmediato (pm2 list / pm2 logs beyonix)."
     echo "Detalle: $(winlog)"; exit 2 ;;
  *) abort "no se activó la versión nueva ($(first_stop))" ;;
esac

# Confirmación externa desde la PC; si falla, rollback SÓLO si la activa sigue siendo la nuestra.
pub=0
for _ in $(seq 1 20); do
  curl -s --max-time 10 "$SITE/" | grep -qF "$NEW_BUILD" && { pub=1; break; }
  sleep 3
done
for p in / /productos /login; do
  [ "$pub" = 1 ] || break
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SITE$p")"
  log "público $p=$code"
  [ "$code" = 200 ] || pub=0
done
t_end verificacion
if [ "$pub" != 1 ]; then
  log "ROLLBACK AUTOMÁTICO: la verificación desde la PC falló"
  remote remote-rollback.sh "$DEPLOY_ID" "$RELEASE" "$ACTIVE"
  case $? in
    0|5) echo "Error: se recuperó la versión anterior (el sitio público no confirmó la versión nueva)." ;;
    *) echo "ALERTA: el sitio público no confirmó la versión nueva y el rollback automático no se completó ($(first_stop))."
       echo "Revisar con: .\\deploy-beyonix.ps1 -Estado" ;;
  esac
  echo "Detalle: $(winlog)"
  exit 1
fi

say "Actualización completada."
echo "Validación: $VALIDATION_DONE"
echo "Versión: $(git -C "$REPO" rev-parse --short HEAD) (build $NEW_BUILD)"
[ "$SWITCH_RC" = 5 ] && echo "Aviso: pm2 save falló; tras un reinicio del VPS revisar con pm2 list."
echo "Detalle: $(winlog)"
exit 0
