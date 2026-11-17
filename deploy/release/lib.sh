#!/usr/bin/env bash
# Funciones locales (PC, Git Bash) de deploy.sh, separadas para poder probarlas aisladas
# (deploy/release/tests/run-local-tests.sh). No ejecuta nada al cargarse.

DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPS_REL_ROOT=/home/beyonix/apps/beyonix-releases

# ── Argumentos que viajan por SSH ──────────────────────────────────────────────
# Lista blanca estricta: cualquier otro carácter (espacios, ; | & $ ` ' " < > \ saltos) o ".." se rechaza.
is_safe_remote_arg() { [[ "$1" =~ ^[A-Za-z0-9/._-]+$ ]] && [[ "$1" != *..* ]]; }
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
is_deploy_id() { [[ "$1" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$ ]]; }
is_release_path() { [[ "$1" =~ ^/home/beyonix/apps/beyonix-releases/[0-9a-f]{7}-[0-9]{8}-[0-9]{6}$ ]]; }
is_incoming_path() { [[ "$1" =~ ^/home/beyonix/apps/beyonix-releases/incoming-[0-9]{8}-[0-9]{6}$ ]]; }

# Normaliza el destino de -Rollback -Version: acepta el nombre de la release o su ruta completa.
normalize_release_arg() {
  local v="$1"
  [[ "$v" =~ ^[0-9a-f]{7}-[0-9]{8}-[0-9]{6}$ ]] && v="$VPS_REL_ROOT/$v"
  is_release_path "$v" || return 1
  printf '%s\n' "$v"
}

# Arma la línea de comando remota "bash -s -- a b c" sólo con argumentos de la lista blanca.
remote_command() {
  local a cmd="bash -s --"
  for a in "$@"; do
    is_safe_remote_arg "$a" || return 1
    cmd+=" $a"
  done
  printf '%s\n' "$cmd"
}

new_deploy_id() { printf '%s-%s\n' "$(date +%Y%m%d-%H%M%S)" "$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"; }

# ── Migraciones ────────────────────────────────────────────────────────────────
# Lee la salida de `supabase db query --agent no -o json`: exige un array JSON NO vacío de objetos
# {"version": "<14 dígitos>"}, sin duplicados. Cualquier otra forma => error (exit != 0).
parse_remote_migrations() {
  node -e '
    const s = require("fs").readFileSync(0, "utf8").trim()
    let rows
    try { rows = JSON.parse(s) } catch { console.error("no es JSON"); process.exit(3) }
    if (!Array.isArray(rows) || rows.length === 0) { console.error("no es un array con filas"); process.exit(4) }
    const seen = new Set()
    for (const r of rows) {
      if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== 1 ||
          typeof r.version !== "string" || !/^\d{14}$/.test(r.version)) { console.error("fila inválida"); process.exit(5) }
      if (seen.has(r.version)) { console.error("versión duplicada"); process.exit(6) }
      seen.add(r.version)
    }
    console.log([...seen].sort().join("\n"))'
}

# Versiones de las migraciones del commit. Falla si hay un .sql con nombre ambiguo o versiones repetidas.
local_migrations_of_commit() { # <repo> <sha>
  local files bad versions
  files="$(git -C "$1" ls-tree --name-only "$2" supabase/migrations/ | grep -E '\.sql$' || true)"
  [ -n "$files" ] || return 1
  bad="$(grep -vE '^supabase/migrations/[0-9]{14}_[A-Za-z0-9_]+\.sql$' <<< "$files" || true)"
  [ -z "$bad" ] || { echo "nombre de migración ambiguo: $bad" >&2; return 1; }
  versions="$(sed -E 's#^supabase/migrations/([0-9]{14})_.*#\1#' <<< "$files" | LC_ALL=C sort)"
  [ "$(uniq -d <<< "$versions")" = "" ] || { echo "versiones de migración repetidas" >&2; return 1; }
  printf '%s\n' "$versions"
}

# Compara listas ordenadas: imprime "pendientes=..." y "desconocidas=..." (separadas por espacios).
compare_migrations() { # <remotas> <locales>
  printf 'pendientes=%s\n' "$(LC_ALL=C comm -13 <(printf '%s\n' "$1") <(printf '%s\n' "$2") | tr '\n' ' ' | sed 's/ $//')"
  printf 'desconocidas=%s\n' "$(LC_ALL=C comm -23 <(printf '%s\n' "$1") <(printf '%s\n' "$2") | tr '\n' ' ' | sed 's/ $//')"
}

# ── Timeout con árbol de procesos (Windows) ────────────────────────────────────
# run_with_tree_timeout <segundos> <log> <comando...>: corre el comando en segundo plano con su
# salida al log. Si supera el tiempo, termina TODO su árbol (incluidos huérfanos registrados en las
# fotos periódicas) con escalada y comprueba que no quede nada. Devuelve el código del comando,
# 124 si hubo timeout y quedó limpio, 125 si quedaron procesos vivos.
run_with_tree_timeout() {
  local limit="$1" log="$2"; shift 2
  local snapshot_every="${TREE_SNAPSHOT_SECONDS:-20}" known pid winpid start last_snap rc kill_out
  known="$(mktemp)"
  "$@" >> "$log" 2>&1 &
  pid=$!
  winpid="$(cat "/proc/$pid/winpid" 2>/dev/null)"
  start=$(date +%s); last_snap=$start
  # Tiempo real (reloj de pared): las fotos del árbol tardan y no deben estirar el límite.
  while kill -0 "$pid" 2>/dev/null; do
    if [ $(( $(date +%s) - start )) -ge "$limit" ]; then
      echo "[timeout] ${limit}s superados: terminando el árbol de procesos (winpid=$winpid)" >> "$log"
      kill_out="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$DEPLOY_LIB_DIR/kill-process-tree.ps1")" \
        -RootPid "$winpid" -KnownFile "$(cygpath -w "$known")" 2>&1 | tr -d '\r')"
      printf '%s\n' "$kill_out" >> "$log"
      kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      rm -f "$known"
      grep -qx 'restantes=0' <<< "$kill_out" && return 124
      return 125
    fi
    if [ $(( $(date +%s) - last_snap )) -ge "$snapshot_every" ] && [ -n "$winpid" ]; then
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$DEPLOY_LIB_DIR/kill-process-tree.ps1")" \
        -RootPid "$winpid" -KnownFile "$(cygpath -w "$known")" -Snapshot >/dev/null 2>&1
      last_snap=$(date +%s)
    fi
    sleep 1
  done
  wait "$pid"; rc=$?
  rm -f "$known"
  return "$rc"
}

# ── Corte de red durante la activación ─────────────────────────────────────────
# await_switch_result <deploy-id> <intentos> <espera>: el script remoto sigue solo si se corta la
# conexión; esto reintenta leer su resultado. Usa la función `fetch_status` (definida por quien llama)
# que imprime la salida de remote-status.sh. Imprime el resultado (ACTIVADA, ROLLBACK_OK, ...) o
# "desconocido".
await_switch_result() {
  local id="$1" tries="$2" pause="$3" i out res lock
  for ((i = 0; i < tries; i++)); do
    if out="$(fetch_status "$id")"; then
      res="$(sed -n 's/^switch_result=//p' <<< "$out" | sed -n 1p)"
      lock="$(sed -n 's/^switch_lock=//p' <<< "$out" | sed -n 1p)"
      if [ -n "$res" ] && [ "$res" != desconocido ] && [ "$lock" = libre ]; then
        printf '%s\n' "$res"; return 0
      fi
    fi
    sleep "$pause"
  done
  echo desconocido
  return 1
}
