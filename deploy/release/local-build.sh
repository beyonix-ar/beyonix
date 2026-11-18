#!/usr/bin/env bash
# PC (Git Bash) — Compila el commit en un entorno de compilación persistente y exclusivo, fuera del
# repo, y empaqueta el .next. No toca el VPS ni la base de datos; del repo sólo lee (git archive,
# .env.local). Las dependencias se instalan con `npm ci` desde el package-lock DEL COMMIT y se
# reutilizan mientras no cambien el lock, el package.json, node, npm ni la plataforma, y su
# contenido (huella sha256 de cada archivo y enlace) siga idéntico al instalado.
# Uso: bash local-build.sh <sha-completo> <repo> <dir-salida> <dir-entorno>
# Emite "tiempo <etapa>=<ms>". Última línea si todo pasa: LISTO artefacto=<dir> build_id=<id>
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

SHA="${1:?uso: local-build.sh <sha> <repo> <dir-salida> <dir-entorno>}"
REPO="${2:?falta repo}"
OUT_ROOT="${3:?falta dir-salida}"
ENV_ROOT="${4:?falta dir-entorno}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "DETENER: SHA inválido"; exit 2; }
fail() { echo "DETENER: $*"; exit 1; }
T=$(now_ms)
lap() { echo "tiempo $1=$(( $(now_ms) - T ))"; T=$(now_ms); }

[ "$(git -C "$REPO" rev-parse "$SHA^{commit}")" = "$SHA" ] || fail "commit inexistente en el repo local"
[ -f "$REPO/.env.local" ] || fail "falta .env.local en el repo"
case "$ENV_ROOT" in */build-env) ;; *) fail "dir-entorno debe terminar en /build-env" ;; esac
mkdir -p "$OUT_ROOT" "$ENV_ROOT"
WORK="$ENV_ROOT/work"
STAMP="$ENV_ROOT/deps.stamp"
LOCKD="$ENV_ROOT/.lock"

# Uso exclusivo del entorno. Un bloqueo de un proceso que ya no existe (cierre forzado) se recupera.
if ! mkdir "$LOCKD" 2>/dev/null; then
  holder="$(cat "$LOCKD/pid" 2>/dev/null || true)"
  if [[ "$holder" =~ ^[0-9]+$ ]] && ! kill -0 "$holder" 2>/dev/null; then
    echo "bloqueo abandonado del proceso $holder: se recupera"
    rm -rf -- "$LOCKD"; mkdir "$LOCKD" || fail "el entorno de compilación está en uso"
  else
    fail "el entorno de compilación está en uso por otra ejecución"
  fi
fi
echo $$ > "$LOCKD/pid"

# Deja en WORK sólo node_modules (sin su caché): ni fuentes, ni .next, ni .env.local de otra ejecución.
wipe_work() {
  case "$WORK" in */build-env/work) ;; *) return 1 ;; esac
  [ -d "$WORK" ] || return 0
  find "$WORK" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +
  rm -rf -- "$WORK/node_modules/.cache"
}
cleanup() {
  rm -f -- "$WORK/.env.local"
  wipe_work || true
  rm -rf -- "$LOCKD"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

wipe_work || fail "no se pudo limpiar el entorno de compilación"
mkdir -p "$WORK"
A="$OUT_ROOT/${SHA:0:7}-$(date +%Y%m%d-%H%M%S)"
mkdir "$A"
echo "artefacto=$A entorno=$WORK"

# Árbol exacto del commit (sin archivos no versionados ni cachés locales: evita CSS viejo de Turbopack).
git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$WORK"
# git archive aplica core.autocrlf (CRLF); git show no: se compara sin CR.
cmp -s <(git -C "$REPO" show "$SHA:package-lock.json" | tr -d '\r') <(tr -d '\r' < "$WORK/package-lock.json") \
  || fail "package-lock extraído distinto del commit"
lap entorno

# Dependencias: reutilizar sólo si la identidad coincide y la huella está intacta; si no, npm ci limpio.
key="$(deps_key "$REPO" "$SHA")" || fail "no se pudo calcular la identidad de las dependencias"
reuse=0
if [ -f "$STAMP" ] && [ -d "$WORK/node_modules" ]; then
  stamp_key="$(sed -n 's/^key=//p' "$STAMP")"
  stamp_print="$(sed -n 's/^huella=//p' "$STAMP")"
  if [ "$(grep -c '^key=' "$STAMP")" != 1 ] || [ "$(grep -c '^huella=' "$STAMP")" != 1 ] \
     || ! [[ "$stamp_print" =~ $DEPS_FINGERPRINT_RE ]]; then
    echo "dependencias: sello incompleto o corrupto => reinstalar"
  elif [ "$stamp_key" != "$key" ]; then
    echo "dependencias: cambió package-lock, package.json o herramientas => reinstalar"
  elif ! current_print="$(deps_fingerprint "$WORK")"; then
    echo "dependencias: no se pudo comprobar la integridad de node_modules => reinstalar"
  elif [ "$stamp_print" != "$current_print" ]; then
    echo "dependencias: node_modules alterado o incompleto (contenido distinto) => reinstalar"
  else
    reuse=1
  fi
else
  echo "dependencias: sin instalación previa válida => instalar"
fi
if [ "$reuse" = 1 ]; then
  echo "dependencias=reutilizadas ($key)"
else
  rm -f -- "$STAMP"          # sin sello mientras se instala: una interrupción obliga a reinstalar
  rm -rf -- "$WORK/node_modules"
  : > "$A/npm-ci.log"
  run_with_tree_timeout 1800 "$A/npm-ci.log" bash -c 'cd "$1" && npm ci --no-audit --no-fund --loglevel=error' _ "$WORK" \
    || { tail -20 "$A/npm-ci.log"; fail "npm ci falló o superó 30 min"; }
  rm -rf -- "$WORK/node_modules/.cache"
  # Sin huella completa no hay sello: la próxima compilación reinstala (nunca se reutiliza sin verificar).
  if installed_print="$(deps_fingerprint "$WORK")"; then
    printf 'key=%s\nhuella=%s\ninstalado_en=%s\n' "$key" "$installed_print" "$(date -Is)" > "$STAMP.tmp"
    mv -f -- "$STAMP.tmp" "$STAMP"
  else
    echo "AVISO: no se pudo calcular la integridad de node_modules; no se guarda sello (se reinstalará)"
  fi
  echo "dependencias=instaladas con npm ci ($key)"
fi
echo "integridad_dependencias=${installed_print:-${current_print:-no calculada}}"
lap dependencias

# .env.local sólo durante el build (las NEXT_PUBLIC_* ya se compararon con las del VPS); se borra siempre.
cp "$REPO/.env.local" "$WORK/.env.local"
(cd "$WORK" && NEXT_TELEMETRY_DISABLED=1 npm run build) > "$A/build.log" 2>&1 \
  || { tail -30 "$A/build.log"; fail "el build falló"; }
rm -f -- "$WORK/.env.local"
lap next_build

N="$WORK/.next"
BUILD_ID="$(cat "$N/BUILD_ID")"
[ -n "$BUILD_ID" ] || fail "sin BUILD_ID"
css_count="$( { ls "$N"/static/chunks/*.css 2>/dev/null || true; } | wc -l)"
[ "$css_count" -gt 0 ] || fail "el build no generó CSS"
win_bin="$( { grep -rlaE 'win32-x64|sharp-win32' "$N/server" "$N/static" --include=*.js || true; } | wc -l)"
[ "$win_bin" = "0" ] || fail "el runtime referencia binarios Windows"
win_paths="$( { grep -rlaE '[A-Z]:(\\\\|/)(BEYONIX|Users)' "$N/server" "$N/static" --include=*.js || true; } | wc -l)"
[ "$win_paths" = "0" ] || fail "el runtime contiene rutas Windows"
env_leak="$( { find "$N" -name '.env*' -print || true; } | wc -l)"
[ "$env_leak" = "0" ] || fail "el build contiene archivos .env"

tar -C "$WORK" -czf "$A/next-build.tar.gz" --exclude=.next/cache --exclude=.next/dev .next
(cd "$WORK" && find .next -path .next/cache -prune -o -path .next/dev -prune -o -type f -print0 | sort -z | xargs -0 sha256sum) \
  | sed 's/ \*/  /' > "$A/next-files.sha256"
{
  echo "sha=$SHA"
  echo "build_id=$BUILD_ID"
  echo "built_at=$(date -Is)"
  echo "build_platform=win32-x64"
  echo "node=$(node -v)"
  echo "deps=$key"
  echo "files=$(wc -l < "$A/next-files.sha256")"
} > "$A/meta.env"
(cd "$A" && sha256sum next-build.tar.gz next-files.sha256 meta.env | sed 's/ \*/  /' > SHA256SUMS)
lap empaquetado

wipe_work
lap limpieza
echo "LISTO artefacto=$A build_id=$BUILD_ID"
