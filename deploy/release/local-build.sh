#!/usr/bin/env bash
# PC (Git Bash) — Compila el commit en un directorio limpio fuera del repo y empaqueta el .next.
# No toca el VPS ni la base de datos; del repo sólo lee (git archive, node_modules, .env.local).
# Uso: bash local-build.sh <sha-completo> <repo> <dir-salida>
# Última línea si todo pasa: LISTO artefacto=<dir> build_id=<id>
set -euo pipefail
umask 077

SHA="${1:?uso: local-build.sh <sha> <repo> <dir-salida>}"
REPO="${2:?falta repo}"
OUT_ROOT="${3:?falta dir-salida}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "DETENER: SHA inválido"; exit 2; }
fail() { echo "DETENER: $*"; exit 1; }

[ "$(git -C "$REPO" rev-parse "$SHA^{commit}")" = "$SHA" ] || fail "commit inexistente en el repo local"
[ -d "$REPO/node_modules" ] || fail "falta node_modules en el repo (npm ci)"
[ -f "$REPO/.env.local" ] || fail "falta .env.local en el repo"
mkdir -p "$OUT_ROOT"
W="$OUT_ROOT/${SHA:0:7}-$(date +%Y%m%d-%H%M%S)"
mkdir "$W" "$W/src"
echo "workdir=$W"

# Árbol exacto del commit: sin archivos no versionados ni cachés locales (evita CSS viejo de Turbopack).
git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$W/src"
cmp -s "$REPO/package-lock.json" "$W/src/package-lock.json" || fail "package-lock del repo distinto del commit"
cp -a "$REPO/node_modules" "$W/src/node_modules"

# .env.local sólo durante el build (las NEXT_PUBLIC_* ya se compararon con las del VPS); se borra siempre.
cp "$REPO/.env.local" "$W/src/.env.local"
cleanup() { rm -f "$W/src/.env.local"; }
trap cleanup EXIT

start_ts=$(date +%s)
(cd "$W/src" && NEXT_TELEMETRY_DISABLED=1 npm run build) > "$W/build.log" 2>&1 \
  || { tail -30 "$W/build.log"; fail "el build falló"; }
echo "build_segundos=$(( $(date +%s) - start_ts ))"
rm -f "$W/src/.env.local"

N="$W/src/.next"
BUILD_ID="$(cat "$N/BUILD_ID")"
[ -n "$BUILD_ID" ] || fail "sin BUILD_ID"
css_count="$( { ls "$N"/static/chunks/*.css 2>/dev/null || true; } | wc -l)"
[ "$css_count" -gt 0 ] || fail "el build no generó CSS"
win_bin="$( { grep -rlaE 'win32-x64|sharp-win32' "$N/server" "$N/static" --include=*.js || true; } | wc -l)"
[ "$win_bin" = "0" ] || fail "el runtime referencia binarios Windows"
win_paths="$( { grep -rlaE '[A-Z]:(\\\\|/)(BEYONIX|Users)' "$N/server" "$N/static" --include=*.js || true; } | wc -l)"
[ "$win_paths" = "0" ] || fail "el runtime contiene rutas Windows"

tar -C "$W/src" -czf "$W/next-build.tar.gz" --exclude=.next/cache --exclude=.next/dev .next
(cd "$W/src" && find .next -path .next/cache -prune -o -path .next/dev -prune -o -type f -print0 | sort -z | xargs -0 sha256sum) \
  | sed 's/ \*/  /' > "$W/next-files.sha256"
{
  echo "sha=$SHA"
  echo "build_id=$BUILD_ID"
  echo "built_at=$(date -Is)"
  echo "build_platform=win32-x64"
  echo "node=$(node -v)"
  echo "files=$(wc -l < "$W/next-files.sha256")"
} > "$W/meta.env"
(cd "$W" && sha256sum next-build.tar.gz next-files.sha256 meta.env | sed 's/ \*/  /' > SHA256SUMS)

# El artefacto es el .tar.gz: la copia de fuentes y node_modules ya no hace falta.
case "$W/src" in "$OUT_ROOT"/*/src) rm -rf -- "$W/src" ;; esac
trap - EXIT
echo "LISTO artefacto=$W build_id=$BUILD_ID"
