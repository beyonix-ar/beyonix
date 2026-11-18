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
    aprobacion) echo "Aprobación previa (identidad e integridad)" ;;
    lint) echo "ESLint" ;;
    typecheck) echo "TypeScript" ;;
    tests) echo "Tests" ;;
    integridad_aprobacion) echo "Integridad de dependencias (post-validación)" ;;
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

# ── Validaciones y su aprobación por commit ────────────────────────────────────
# Dos niveles, nunca intercambiables:
#   estandar  lint + typecheck (deploy normal; npm test NO se ejecuta)
#   completa  lint + typecheck + npm test (sólo con --validacion-completa)
# Cada nivel tiene su propio archivo de aprobación y su lista de validaciones dentro de la identidad.
# Se reutiliza sólo si TODA la identidad coincide; cualquier duda => se valida de nuevo.
APPROVAL_SCHEMA=3
VALIDATION_SPEC='lint=npm run lint|typecheck=npm run typecheck'
VALIDATION_SPEC_FULL='lint=npm run lint|typecheck=npm run typecheck|tests=npm test'
sha256_of() { sha256sum | cut -d' ' -f1; }
is_validation_level() { [ "$1" = estandar ] || [ "$1" = completa ]; }
validation_spec() { # <nivel>
  case "$1" in
    estandar) printf '%s\n' "$VALIDATION_SPEC" ;;
    completa) printf '%s\n' "$VALIDATION_SPEC_FULL" ;;
    *) return 1 ;;
  esac
}
validation_description() { # <nivel>
  case "$1" in
    estandar) echo "estándar: ESLint + TypeScript (npm test NO ejecutado)" ;;
    completa) echo "completa: ESLint + TypeScript + npm test" ;;
    *) return 1 ;;
  esac
}

# approval_base_identity <repo> <sha>: líneas clave=valor comunes a ambos niveles (la parte costosa:
# incluye la huella por contenido de node_modules). Los secretos sólo intervienen como hash. Falla si
# algún dato no se puede determinar. dependencias_contenido ata la aprobación al node_modules validado.
approval_base_identity() {
  local repo="$1" sha="$2" tree lock deps deps_content env_local node_v npm_v
  is_sha "$sha" || return 1
  node_v="$(node -v 2>/dev/null)" && [ -n "$node_v" ] || return 1
  npm_v="$(npm -v 2>/dev/null)" && [ -n "$npm_v" ] || return 1
  tree="$(git -C "$repo" rev-parse "$sha^{tree}" 2>/dev/null)" && [ -n "$tree" ] || return 1
  git -C "$repo" cat-file -e "$sha:package-lock.json" 2>/dev/null || return 1
  lock="$(git -C "$repo" show "$sha:package-lock.json" | sha256_of)" || return 1
  [ -f "$repo/node_modules/.package-lock.json" ] || return 1
  deps="$(sha256_of < "$repo/node_modules/.package-lock.json")"
  deps_content="$(deps_fingerprint "$repo")" || return 1
  [ -f "$repo/.env.local" ] || return 1
  env_local="$(tr -d '\r' < "$repo/.env.local" | sha256_of)"
  printf 'esquema=%s\n' "$APPROVAL_SCHEMA"
  printf 'sha=%s\n' "$sha"
  printf 'arbol=%s\n' "$tree"
  printf 'package_lock=%s\n' "$lock"
  printf 'dependencias_instaladas=%s\n' "$deps"
  printf 'dependencias_contenido=%s\n' "$deps_content"
  printf 'node=%s\n' "$node_v"
  printf 'npm=%s\n' "$npm_v"
  printf 'plataforma=%s\n' "$(uname -sm)"
  printf 'env_local=%s\n' "$env_local"
  printf 'entorno_proceso=%s\n' "$(printf '%s|' "${NODE_OPTIONS:-}" "${NODE_ENV:-}" "${TZ:-}" "${CI:-}" | sha256_of)"
}

# approval_with_level <identidad-base> <nivel>: agrega el nivel y la lista exacta de validaciones.
approval_with_level() {
  local spec
  [ -n "$1" ] || return 1
  spec="$(validation_spec "$2")" || return 1
  printf '%s\nnivel=%s\nvalidaciones=%s\n' "$1" "$2" "$(printf '%s' "$spec" | sha256_of)"
}

# approval_identity <repo> <sha> [nivel=estandar]: identidad completa de un nivel.
approval_identity() {
  local base level="${3:-estandar}"
  is_validation_level "$level" || return 1
  base="$(approval_base_identity "$1" "$2")" || return 1
  approval_with_level "$base" "$level"
}

approval_file() { # <dir> <sha> [nivel=estandar]
  is_validation_level "${3:-estandar}" || return 1
  printf '%s/%s.%s.aprobacion\n' "$1" "$2" "${3:-estandar}"
}

# approval_check <dir> <sha> <identidad> [nivel=estandar]: 0 si hay una aprobación íntegra de ESE nivel
# con la MISMA identidad. Si no, imprime el motivo (sin valores) y devuelve 1.
approval_check() {
  local f body control want key level="${4:-estandar}"
  f="$(approval_file "$1" "$2" "$level")" || { echo "nivel de validación inválido"; return 1; }
  [ -f "$f" ] || { echo "sin aprobación previa para este commit"; return 1; }
  body="$(sed '$d' "$f")"
  control="$(sed -n '$s/^control=//p' "$f")"
  [ -n "$control" ] && [ "$control" = "$(printf '%s\n' "$body" | sha256_of)" ] \
    || { echo "aprobación dañada o editada (control inválido)"; return 1; }
  [ "$(sed -n 's/^resultado=//p' <<< "$body")" = aprobado ] || { echo "aprobación sin resultado aprobado"; return 1; }
  want="$3"
  [ -n "$want" ] || { echo "identidad actual indeterminada"; return 1; }
  [ "$(grep -c '^nivel=' <<< "$want")" = 1 ] && [ "$(sed -n 's/^nivel=//p' <<< "$want")" = "$level" ] \
    || { echo "identidad de otro nivel de validación"; return 1; }
  while IFS= read -r key; do
    key="${key%%=*}"
    [ "$(grep -c "^$key=" <<< "$body")" = 1 ] \
      && [ "$(grep "^$key=" <<< "$body")" = "$(grep "^$key=" <<< "$want")" ] \
      || { echo "cambió: $key"; return 1; }
  done <<< "$want"
  return 0
}

# approval_pick <dir> <sha> <identidad-base>: para un deploy ESTÁNDAR imprime el nivel de una aprobación
# reutilizable (prefiere completa, que también cubre lint y typecheck). Sin ninguna válida, imprime los
# motivos en stderr y devuelve 1. Un deploy con --validacion-completa nunca reutiliza: valida siempre.
approval_pick() {
  local level reason
  [ -n "$3" ] || { echo "identidad actual indeterminada" >&2; return 1; }
  for level in completa estandar; do
    if reason="$(approval_check "$1" "$2" "$(approval_with_level "$3" "$level")" "$level")"; then
      printf '%s\n' "$level"; return 0
    fi
    echo "$level: $reason" >&2
  done
  return 1
}

# approval_revoke <dir> <sha> [nivel=estandar]: se llama ANTES de validar; una validación interrumpida
# o fallida no deja aprobación de ese nivel.
approval_revoke() { local f; f="$(approval_file "$1" "$2" "${3:-estandar}")" || return 1; rm -f -- "$f"; }

# approval_revoke_all <dir> <sha>: antes de CUALQUIER validación se invalidan todos los niveles (todos
# dependen de lint y typecheck): un fallo o una interrupción no deja ninguno reutilizable.
approval_revoke_all() { approval_revoke "$1" "$2" estandar && approval_revoke "$1" "$2" completa; }

# validation_passed_level <nivel> <rc-de-validate_commit>: 0 si esa ejecución demostró el nivel.
# Estándar: lint y typecheck pasaron (rc 0, o 12/124/125 = sólo fallaron o se cortaron los tests).
# Completa: rc 0 (sólo existe si se ejecutó npm test y pasó).
validation_passed_level() {
  case "$1:$2" in
    estandar:0|estandar:12|estandar:124|estandar:125|completa:0) return 0 ;;
    *) return 1 ;;
  esac
}

# approval_record <dir> <sha> <nivel-ejecutado> <rc> <identidad-base-antes> <identidad-base-después> <log>:
# guarda sólo los niveles que ESTA ejecución demostró, y sólo si la identidad no cambió mientras se
# validaba. Imprime los niveles guardados; devuelve 1 si no guardó ninguno.
approval_record() {
  local dir="$1" sha="$2" ran="$3" rc="$4" before="$5" after="$6" logref="$7" level saved=""
  is_validation_level "$ran" || return 1
  [ -n "$before" ] && [ "$before" = "$after" ] || return 1
  for level in estandar completa; do
    [ "$level" = completa ] && [ "$ran" != completa ] && continue
    validation_passed_level "$level" "$rc" || continue
    approval_save "$dir" "$sha" "$(approval_with_level "$before" "$level")" "$logref" "$level" || return 1
    saved+="$level"$'\n'
  done
  [ -n "$saved" ] || return 1
  printf '%s' "$saved"
}

# approval_save <dir> <sha> <identidad> <log> [nivel=estandar]: sólo tras pasar TODAS las validaciones
# del nivel. Escritura atómica; la identidad debe ser del mismo nivel que el archivo.
approval_save() {
  local f tmp body level="${5:-estandar}"
  [ "$(sed -n 's/^nivel=//p' <<< "$3")" = "$level" ] || return 1
  mkdir -p "$1" || return 1
  f="$(approval_file "$1" "$2" "$level")" || return 1
  # Temporal único por escritura ($$ es el mismo en subshells concurrentes).
  tmp="$(mktemp "$f.tmp.XXXXXX")" || return 1
  body="$(printf '%s\nresultado=aprobado\naprobado_en=%s\nlog=%s' "$3" "$(date -Is)" "$4")"
  { printf '%s\n' "$body"; printf 'control=%s\n' "$(printf '%s\n' "$body" | sha256_of)"; } > "$tmp" && mv -f -- "$tmp" "$f" \
    || { rm -f -- "$tmp"; return 1; }
}

# validate_commit <repo> <nivel> <log>: corre las validaciones del nivel con su salida al log e imprime
# "tiempo <etapa>=<ms>" por etapa. npm test SÓLO en nivel completa (máx. 90 min, con limpieza del árbol
# de procesos). Devuelve 0; 10 lint, 11 typecheck, 12 tests fallidos; 124/125 timeout de tests;
# 2 nivel inválido.
validate_commit() {
  local repo="$1" level="$2" log="$3" t rc
  is_validation_level "$level" || return 2
  t=$(now_ms)
  echo "\$ npm run lint" >> "$log"
  (cd "$repo" && timeout 900 npm run lint) >> "$log" 2>&1 || return 10
  echo "tiempo lint=$(( $(now_ms) - t ))"; t=$(now_ms)
  echo "\$ npm run typecheck" >> "$log"
  (cd "$repo" && timeout 900 npm run typecheck) >> "$log" 2>&1 || return 11
  echo "tiempo typecheck=$(( $(now_ms) - t ))"; t=$(now_ms)
  if [ "$level" != completa ]; then
    echo "npm test omitido (validación estándar)" >> "$log"
    return 0
  fi
  echo "\$ npm test (máx. 90 min, con limpieza del árbol de procesos)" >> "$log"
  (cd "$repo" && run_with_tree_timeout 5400 "$log" npm test); rc=$?
  case $rc in
    0) echo "tiempo tests=$(( $(now_ms) - t ))" ;;
    124|125) return "$rc" ;;
    *) return 12 ;;
  esac
}

# ── Integridad de dependencias instaladas ──────────────────────────────────────
# deps_fingerprint <dir-con-node_modules>: huella por CONTENIDO (sha256 de cada archivo, enlaces y sus
# destinos, directorios; ver deps-fingerprint.mjs). Imprime "<sha256> archivos=N enlaces=N bytes=N" o
# falla sin imprimir nada si la integridad no se pudo comprobar por completo (nunca una huella parcial).
DEPS_FINGERPRINT_RE='^[0-9a-f]{64} archivos=[0-9]+ enlaces=[0-9]+ bytes=[0-9]+$'
deps_fingerprint() {
  local out
  [ -d "$1/node_modules" ] && [ ! -L "$1/node_modules" ] || return 1
  out="$(node "$DEPLOY_LIB_DIR/deps-fingerprint.mjs" "$1/node_modules" 2>/dev/null)" || return 1
  [[ "$out" =~ $DEPS_FINGERPRINT_RE ]] || return 1
  printf '%s\n' "$out"
}

# ── Entorno de compilación persistente (PC) ────────────────────────────────────
# Identidad de las dependencias: package-lock y package.json del COMMIT (npm ci exige que coincidan y
# ejecuta los scripts de instalación del package.json) + herramientas.
DEPS_STAMP_SCHEMA=2
deps_key() { # <repo> <sha>
  local lock pkg node_v npm_v
  git -C "$1" cat-file -e "$2:package-lock.json" 2>/dev/null || return 1
  git -C "$1" cat-file -e "$2:package.json" 2>/dev/null || return 1
  lock="$(git -C "$1" show "$2:package-lock.json" | sha256_of)" && [ -n "$lock" ] || return 1
  pkg="$(git -C "$1" show "$2:package.json" | sha256_of)" && [ -n "$pkg" ] || return 1
  node_v="$(node -v 2>/dev/null)" && [ -n "$node_v" ] || return 1
  npm_v="$(npm -v 2>/dev/null)" && [ -n "$npm_v" ] || return 1
  printf 'esquema=%s lock=%s package=%s node=%s npm=%s plataforma=%s\n' \
    "$DEPS_STAMP_SCHEMA" "$lock" "$pkg" "$node_v" "$npm_v" "$(uname -sm | tr ' ' _)"
}
