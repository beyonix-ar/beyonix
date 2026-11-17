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

# ── Medición de tiempos ────────────────────────────────────────────────────────
now_ms() { date +%s%3N; }
# 1234 => "1,2 s"; 95000 => "1 min 35 s"
fmt_ms() {
  local ms="$1"
  if [ "$ms" -lt 60000 ]; then printf '%d,%d s' $((ms / 1000)) $(((ms % 1000) / 100))
  else printf '%d min %02d s' $((ms / 60000)) $(((ms % 60000) / 1000)); fi
}
stage_label() {
  case "$1" in
    git) echo "Validaciones Git" ;;
    vps) echo "Comprobaciones VPS" ;;
    variables) echo "Variables públicas" ;;
    migraciones) echo "Migraciones" ;;
    aprobacion) echo "Consulta de aprobación previa" ;;
    lint) echo "ESLint" ;;
    typecheck) echo "TypeScript" ;;
    tests) echo "Tests" ;;
    entorno) echo "Entorno de compilación" ;;
    dependencias) echo "Dependencias (verificación/instalación)" ;;
    next_build) echo "Next.js build" ;;
    empaquetado) echo "Empaquetado y manifest" ;;
    limpieza) echo "Limpieza del entorno" ;;
    transferencia) echo "Transferencia" ;;
    vps_artefacto) echo "VPS: integridad del artefacto" ;;
    vps_codigo) echo "VPS: código del commit" ;;
    vps_dependencias) echo "VPS: dependencias" ;;
    vps_extraccion) echo "VPS: extracción y hashes" ;;
    vps_humo) echo "VPS: smoke tests" ;;
    ventana) echo "Espera de ventana segura" ;;
    activacion) echo "Activación (bloqueo, PM2, estabilidad)" ;;
    verificacion) echo "Verificación pública" ;;
    *) echo "$1" ;;
  esac
}

# ── Aprobación de validaciones (lint + typecheck + tests) por commit ──────────
# Se reutiliza sólo si TODA la identidad coincide; cualquier duda => validación completa.
APPROVAL_SCHEMA=1
VALIDATION_SPEC='lint=npm run lint|typecheck=npm run typecheck|tests=npm test'
sha256_of() { sha256sum | cut -d' ' -f1; }

# approval_identity <repo> <sha>: líneas clave=valor que determinan el resultado de las validaciones.
# Los secretos sólo intervienen como hash. Falla si algún dato no se puede determinar.
approval_identity() {
  local repo="$1" sha="$2" tree lock deps env_local node_v npm_v
  is_sha "$sha" || return 1
  node_v="$(node -v 2>/dev/null)" && [ -n "$node_v" ] || return 1
  npm_v="$(npm -v 2>/dev/null)" && [ -n "$npm_v" ] || return 1
  tree="$(git -C "$repo" rev-parse "$sha^{tree}" 2>/dev/null)" && [ -n "$tree" ] || return 1
  git -C "$repo" cat-file -e "$sha:package-lock.json" 2>/dev/null || return 1
  lock="$(git -C "$repo" show "$sha:package-lock.json" | sha256_of)" || return 1
  [ -f "$repo/node_modules/.package-lock.json" ] || return 1
  deps="$(sha256_of < "$repo/node_modules/.package-lock.json")"
  [ -f "$repo/.env.local" ] || return 1
  env_local="$(tr -d '\r' < "$repo/.env.local" | sha256_of)"
  printf 'esquema=%s\n' "$APPROVAL_SCHEMA"
  printf 'sha=%s\n' "$sha"
  printf 'arbol=%s\n' "$tree"
  printf 'package_lock=%s\n' "$lock"
  printf 'dependencias_instaladas=%s\n' "$deps"
  printf 'node=%s\n' "$node_v"
  printf 'npm=%s\n' "$npm_v"
  printf 'plataforma=%s\n' "$(uname -sm)"
  printf 'env_local=%s\n' "$env_local"
  printf 'entorno_proceso=%s\n' "$(printf '%s|' "${NODE_OPTIONS:-}" "${NODE_ENV:-}" "${TZ:-}" "${CI:-}" | sha256_of)"
  printf 'validaciones=%s\n' "$(printf '%s' "$VALIDATION_SPEC" | sha256_of)"
}

approval_file() { printf '%s/%s.aprobacion\n' "$1" "$2"; } # <dir> <sha>

# approval_check <dir> <sha> <identidad>: 0 si hay una aprobación íntegra con la MISMA identidad.
# Si no, imprime el motivo (sin valores) y devuelve 1.
approval_check() {
  local f body control want key
  f="$(approval_file "$1" "$2")"
  [ -f "$f" ] || { echo "sin aprobación previa para este commit"; return 1; }
  body="$(sed '$d' "$f")"
  control="$(sed -n '$s/^control=//p' "$f")"
  [ -n "$control" ] && [ "$control" = "$(printf '%s\n' "$body" | sha256_of)" ] \
    || { echo "aprobación dañada o editada (control inválido)"; return 1; }
  [ "$(sed -n 's/^resultado=//p' <<< "$body")" = aprobado ] || { echo "aprobación sin resultado aprobado"; return 1; }
  want="$3"
  [ -n "$want" ] || { echo "identidad actual indeterminada"; return 1; }
  while IFS= read -r key; do
    key="${key%%=*}"
    [ "$(grep -c "^$key=" <<< "$body")" = 1 ] \
      && [ "$(grep "^$key=" <<< "$body")" = "$(grep "^$key=" <<< "$want")" ] \
      || { echo "cambió: $key"; return 1; }
  done <<< "$want"
  return 0
}

# approval_revoke <dir> <sha>: se llama ANTES de validar; una validación interrumpida o fallida no deja aprobación.
approval_revoke() { rm -f -- "$(approval_file "$1" "$2")"; }

# approval_save <dir> <sha> <identidad> <log>: sólo tras pasar las tres validaciones. Escritura atómica.
approval_save() {
  local f tmp body
  mkdir -p "$1" || return 1
  f="$(approval_file "$1" "$2")"; tmp="$f.tmp.$$"
  body="$(printf '%s\nresultado=aprobado\naprobado_en=%s\nlog=%s' "$3" "$(date -Is)" "$4")"
  { printf '%s\n' "$body"; printf 'control=%s\n' "$(printf '%s\n' "$body" | sha256_of)"; } > "$tmp" && mv -f -- "$tmp" "$f"
}

# ── Entorno de compilación persistente (PC) ────────────────────────────────────
# Identidad de las dependencias: package-lock del COMMIT + herramientas.
deps_key() { # <repo> <sha>
  local lock
  local lock node_v npm_v
  git -C "$1" cat-file -e "$2:package-lock.json" 2>/dev/null || return 1
  lock="$(git -C "$1" show "$2:package-lock.json" | sha256_of)" && [ -n "$lock" ] || return 1
  node_v="$(node -v 2>/dev/null)" && [ -n "$node_v" ] || return 1
  npm_v="$(npm -v 2>/dev/null)" && [ -n "$npm_v" ] || return 1
  printf 'lock=%s node=%s npm=%s plataforma=%s\n' "$lock" "$node_v" "$npm_v" "$(uname -sm | tr ' ' _)"
}
# Huella de node_modules (rutas + tamaños; excluye cachés): detecta archivos borrados, agregados o truncados.
deps_fingerprint() { # <dir-con-node_modules>
  (cd "$1" && [ -d node_modules ] && find node_modules -path node_modules/.cache -prune -o -type f -printf '%P\t%s\n' | LC_ALL=C sort | sha256_of)
}
