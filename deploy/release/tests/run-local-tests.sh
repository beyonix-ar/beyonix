#!/usr/bin/env bash
# Pruebas adversariales locales (PC, Git Bash) de deploy/release/lib.sh y deploy.sh.
# No se conecta al VPS ni a Supabase; usa directorios temporales propios.
# Uso: bash deploy/release/tests/run-local-tests.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
. "$HERE/lib.sh"
PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✔ $*"; }
ko() { FAIL=$((FAIL + 1)); echo "  ✘ $*"; }
check() { if eval "$2"; then ok "$1"; else ko "$1  [condición: $2]"; fi; }
kv() { sed -n "s/^$1=//p" <<< "$2" | sed -n 1p; }
TMP="$(mktemp -d)"
cleanup() { case "$TMP" in /tmp/tmp.*) rm -rf -- "$TMP" ;; esac; }
trap cleanup EXIT

# ── Argumentos SSH manipulados ────────────────────────────────────────────────
echo "1. Argumentos SSH manipulados"
for evil in 'a;rm -rf ~' 'a b' '$(touch x)' '`id`' 'a|b' 'a&b' "a'b" 'a"b' 'a>b' 'a\b' $'a\nb' '../etc' \
            '/home/beyonix/apps/beyonix-releases/../beyonix' '-' ''; do
  [ "$evil" = - ] && continue
  if is_safe_remote_arg "$evil" || remote_command ok "$evil" >/dev/null; then ko "aceptó $(printf '%q' "$evil")"; else ok "rechaza $(printf '%q' "$evil")"; fi
done
check "acepta '-' (marcador sin destino)" 'is_safe_remote_arg -'
check "remote_command arma la línea con argumentos válidos" '[ "$(remote_command abc /home/beyonix/apps/beyonix-releases/1234567-20260101-000000 -)" = "bash -s -- abc /home/beyonix/apps/beyonix-releases/1234567-20260101-000000 -" ]'
check "normalize: nombre de release => ruta completa" '[ "$(normalize_release_arg ac1fe04-20261116-132041)" = /home/beyonix/apps/beyonix-releases/ac1fe04-20261116-132041 ]'
check "normalize: ruta completa válida" 'normalize_release_arg /home/beyonix/apps/beyonix-releases/ac1fe04-20261116-132041 >/dev/null'
for evil in 'ac1fe04-20261116-132041;id' '/tmp/x' '/home/beyonix/apps/beyonix' 'incoming-20261116-132016' '../ac1fe04-20261116-132041'; do
  if normalize_release_arg "$evil" >/dev/null; then ko "normalize aceptó $evil"; else ok "normalize rechaza $(printf '%q' "$evil")"; fi
done
check "deploy-id generado válido" 'is_deploy_id "$(new_deploy_id)"'
check "deploy.sh rechaza -Version manipulada antes de conectarse" \
  '[ "$(bash "$HERE/deploy.sh" --rollback "x;touch $TMP/pwned" 2>&1 | grep -c "versión inválida")" = 1 ] && [ ! -e "$TMP/pwned" ]'

# ── Migraciones ────────────────────────────────────────────────────────────────
echo "2. Consulta de migraciones"
good='[{"version":"20260101000000"},{"version":"20260102000000"}]'
check "JSON válido => versiones ordenadas" '[ "$(parse_remote_migrations <<< "$good" | tr "\n" " ")" = "20260101000000 20260102000000 " ]'
table=$'┌────────┐\n│ version │\n├────────┤\n│ 20260101000000 │\n└────────┘'
for bad in "$table" '[]' '{"rows":[{"version":"20260101000000"}]}' '[{"version":"2026"}]' '[{"version":20260101000000}]' \
           '[{"version":"20260101000000","x":1}]' '[{"version":"20260101000000"},{"version":"20260101000000"}]' \
           "$good basura" '' 'null'; do
  if parse_remote_migrations <<< "$bad" >/dev/null 2>&1; then ko "aceptó formato inválido: ${bad:0:40}"; else ok "rechaza: $(printf '%q' "${bad:0:40}")"; fi
done
r=$'20260101000000\n20260102000000'; l=$'20260101000000\n20260102000000\n20260103000000'
check "detecta migración pendiente" '[ "$(kv pendientes "$(compare_migrations "$r" "$l")")" = 20260103000000 ]'
check "detecta migración desconocida en producción" '[ "$(kv desconocidas "$(compare_migrations "$l" "$r")")" = 20260103000000 ]'
check "sin diferencias => vacías" '[ -z "$(kv pendientes "$(compare_migrations "$r" "$r")")" ] && [ -z "$(kv desconocidas "$(compare_migrations "$r" "$r")")" ]'
G="$TMP/repo"; mkdir -p "$G/supabase/migrations"; git -C "$G" init -q
touch "$G/supabase/migrations/20260101000000_uno.sql" "$G/supabase/migrations/20260102000000_dos.sql"
git -C "$G" add . && git -C "$G" -c user.email=t@t -c user.name=t commit -qm a
check "migraciones del commit" '[ "$(local_migrations_of_commit "$G" HEAD | tr "\n" " ")" = "20260101000000 20260102000000 " ]'
touch "$G/supabase/migrations/fix_sin_version.sql"; git -C "$G" add . && git -C "$G" -c user.email=t@t -c user.name=t commit -qm b
check "nombre ambiguo => error" '! local_migrations_of_commit "$G" HEAD >/dev/null 2>&1'
check "repo real: 269 migraciones legibles" '[ "$(local_migrations_of_commit "$(git -C "$HERE" rev-parse --show-toplevel)" HEAD | wc -l)" -ge 269 ]'

# ── Timeout de tests con árbol de procesos ─────────────────────────────────────
echo "3. Timeout de npm test (árbol de procesos)"
cat > "$TMP/tree.js" <<'JS'
// raíz -> intermedio (sale a los 2 s dejando un nieto huérfano) -> nieto; más un hijo directo.
const { spawn } = require("child_process")
const fs = require("fs")
const role = process.argv[2] || "root"
const out = process.argv[3]
fs.appendFileSync(out, process.pid + "\n")
const keep = () => setInterval(() => {}, 1000)
if (role === "root") {
  spawn(process.execPath, [__filename, "mid", out], { stdio: "ignore" })
  spawn(process.execPath, [__filename, "leaf", out], { stdio: "ignore" })
  keep()
} else if (role === "mid") {
  spawn(process.execPath, [__filename, "leaf", out], { stdio: "ignore", detached: false })
  setTimeout(() => process.exit(0), 2000)
} else keep()
JS
PIDS="$TMP/pids"; : > "$PIDS"
node -e 'setInterval(()=>{},1000)' & AJENO=$!; AJENO_WIN="$(cat /proc/$AJENO/winpid)"
start=$(date +%s)
TREE_SNAPSHOT_SECONDS=1 run_with_tree_timeout 6 "$TMP/t.log" node "$(cygpath -w "$TMP/tree.js")" root "$(cygpath -w "$PIDS")"; rc=$?
took=$(( $(date +%s) - start ))
sleep 1
alive=0
for p in $(tr -d '\r' < "$PIDS"); do tasklist //FI "PID eq $p" //NH 2>/dev/null | grep -q node && alive=$((alive + 1)); done
echo "    (rc=$rc, segundos=$took)"; check "timeout => código 124 en menos de 40 s (límite 6 s + escalada)" '[ $rc = 124 ] && [ $took -le 40 ]'
check "se crearon 4 procesos (raíz, intermedio, 2 hojas)" '[ "$(wc -l < "$PIDS")" = 4 ]'
check "no queda ninguno vivo (incluido el huérfano)" '[ $alive = 0 ]'
check "el log registra restantes=0" 'grep -qx "restantes=0" "$TMP/t.log"'
check "proceso ajeno intacto" 'tasklist //FI "PID eq $AJENO_WIN" //NH | grep -q node'
kill "$AJENO" 2>/dev/null
run_with_tree_timeout 30 "$TMP/t2.log" node -e 'process.exit(7)'; rc=$?
check "comando que termina solo => devuelve su código (7)" '[ $rc = 7 ]'
run_with_tree_timeout 30 "$TMP/t3.log" node -e 'console.log("listo")'; rc=$?
check "comando OK => 0 y salida en el log" '[ $rc = 0 ] && grep -q listo "$TMP/t3.log"'

# ── Despliegues concurrentes en la PC ──────────────────────────────────────────
echo "4. Dos despliegues a la vez en la PC"
FAKEHOME="$TMP/userprofile"; mkdir -p "$FAKEHOME/Documents/BEYONIX-backups/deploy-logs/.deploy.lock"
out="$(USERPROFILE="$(cygpath -w "$FAKEHOME")" bash "$HERE/deploy.sh" --estado 2>&1)"; rc=$?
check "segundo despliegue => rechazado" '[ $rc = 1 ] && grep -q "ya hay otro despliegue" <<< "$out"'
check "no borra el bloqueo del otro despliegue" '[ -d "$FAKEHOME/Documents/BEYONIX-backups/deploy-logs/.deploy.lock" ]'

# ── Corte de red durante la activación ─────────────────────────────────────────
echo "5. Interrupción de red durante la activación"
# Contador en archivo: await_switch_result llama a fetch_status dentro de $( ), en un subshell.
echo 0 > "$TMP/calls"
fetch_status() {
  local calls=$(( $(cat "$TMP/calls") + 1 )); echo "$calls" > "$TMP/calls"
  [ $calls -le 2 ] && return 255
  [ $calls -le 3 ] && { printf 'switch_result=desconocido\nswitch_lock=tomado\n'; return 0; }
  printf 'switch_result=ROLLBACK_OK\nswitch_lock=libre\n'
}
res="$(await_switch_result 20260101-000000-aaaaaaa1 10 0)"
check "reconecta y obtiene el resultado final (ROLLBACK_OK)" '[ "$res" = ROLLBACK_OK ]'
fetch_status() { return 255; }
res="$(await_switch_result 20260101-000000-aaaaaaa1 3 0)"; rc=$?
check "sin conexión => 'desconocido' (nunca éxito)" '[ "$res" = desconocido ] && [ $rc = 1 ]'
fetch_status() { printf 'switch_result=ACTIVADA\nswitch_lock=tomado\n'; }
res="$(await_switch_result 20260101-000000-aaaaaaa1 2 0)"
check "con el bloqueo aún tomado no da el resultado por final" '[ "$res" = desconocido ]'

# ── Repo falso para el entorno de compilación y las aprobaciones ───────────────
# Dependencia local empaquetada (sin red) y un "build" que imita la salida de Next.
F="$TMP/fake"; mkdir -p "$F/vendor" "$TMP/dep"
printf '{"name":"dep","version":"1.0.0","main":"index.js"}\n' > "$TMP/dep/package.json"
echo 'module.exports = 1' > "$TMP/dep/index.js"
(cd "$TMP/dep" && npm pack --silent --pack-destination "$(cygpath -w "$F/vendor")" >/dev/null 2>&1)
cat > "$F/package.json" <<'JSON'
{ "name": "fake", "version": "1.0.0", "private": true,
  "scripts": { "build": "node build.js" },
  "dependencies": { "dep": "file:vendor/dep-1.0.0.tgz" } }
JSON
cat > "$F/build.js" <<'JS'
const fs = require("fs")
require("dep")
const ms = Number(process.env.FAKE_BUILD_SLEEP || 0)
if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
for (const d of [".next/static/chunks", ".next/server", ".next/cache"]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(".next/BUILD_ID", "fake" + Date.now())
fs.writeFileSync(".next/static/chunks/a.css", "body{}")
fs.writeFileSync(".next/server/page.js", "module.exports = 1")
fs.writeFileSync(".next/cache/x", "cache")
if (process.env.FAKE_BUILD_LEAK) fs.copyFileSync(".env.local", ".next/server/.env.local")
JS
printf 'node_modules/\n.env.local\n' > "$F/.gitignore"
printf 'SECRETO=valor-de-prueba\nNEXT_PUBLIC_X=1\n' > "$F/.env.local"
(cd "$F" && npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1)
git -C "$F" init -q && git -C "$F" add . && git -C "$F" -c user.email=t@t -c user.name=t commit -qm uno
SHA1="$(git -C "$F" rev-parse HEAD)"
ER="$TMP/perfil/build-env"; OUTB="$TMP/builds"; W="$ER/work"
build() { bash "$HERE/local-build.sh" "${1:-$SHA1}" "$F" "$OUTB" "$ER" 2>&1; }
only_node_modules() { [ "$(ls -A "$W")" = node_modules ]; }

echo "6. Entorno de compilación persistente"
out="$(build)"; rc=$?
check "1ª compilación del commit: instala con npm ci y termina" '[ $rc = 0 ] && grep -q "^dependencias=instaladas" <<< "$out" && grep -q "^LISTO artefacto=" <<< "$out"'
ART="$(sed -n "s/^LISTO artefacto=\([^ ]*\) .*/\1/p" <<< "$out")"
check "emite tiempos de cada subetapa" '[ "$(grep -cE "^tiempo (entorno|dependencias|next_build|empaquetado|limpieza)=[0-9]+$" <<< "$out")" = 5 ]'
check "artefacto completo y SHA256SUMS válido" '(cd "$ART" && sha256sum -c --quiet SHA256SUMS)'
check "el artefacto no incluye .env ni .next/cache" '! tar -tzf "$ART/next-build.tar.gz" | grep -qE "\.env|\.next/cache"'
check "tras compilar, el entorno sólo conserva node_modules" 'only_node_modules'
check "sin .env.local residual en el entorno" '[ ! -e "$W/.env.local" ]'
check "libera el bloqueo del entorno" '[ ! -e "$ER/.lock" ]'
check "el repo original no se modificó" '[ -z "$(git -C "$F" status --porcelain)" ]'
out="$(build)"; rc=$?
check "2ª compilación del mismo commit: reutiliza dependencias" '[ $rc = 0 ] && grep -q "^dependencias=reutilizadas" <<< "$out"'
(cd "$F" && sed -i 's/"version": "1.0.0", "private"/"version": "1.0.1", "private"/' package.json \
  && npm install --package-lock-only --no-audit --no-fund --loglevel=error >/dev/null 2>&1 \
  && git add . && git -c user.email=t@t -c user.name=t commit -qm lock)
SHA2="$(git -C "$F" rev-parse HEAD)"
check "el commit nuevo cambió package-lock" '! git -C "$F" diff --quiet "$SHA1" "$SHA2" -- package-lock.json'
out="$(build "$SHA2")"; rc=$?
check "cambio de package-lock => reinstala" '[ $rc = 0 ] && grep -q "cambió package-lock" <<< "$out" && grep -q "^dependencias=instaladas" <<< "$out"'
out="$(build "$SHA1")"
check "volver al commit anterior => reinstala con SU lock (no mezcla)" 'grep -q "cambió package-lock" <<< "$out" && grep -q "^dependencias=instaladas" <<< "$out"'
rm -f "$W/node_modules/dep/index.js"
out="$(build "$SHA1")"; rc=$?
check "caché alterada (archivo borrado) => reinstala" '[ $rc = 0 ] && grep -q "alterado o incompleto" <<< "$out" && [ -f "$W/node_modules/dep/index.js" ]'
rm -f "$ER/deps.stamp"
out="$(build "$SHA1")"
check "sello ausente (instalación interrumpida) => reinstala" 'grep -q "sin instalación previa válida" <<< "$out"'
echo basura > "$ER/deps.stamp"
out="$(build "$SHA1")"
check "sello corrupto => reinstala" 'grep -q "^dependencias=instaladas" <<< "$out"'

echo "7. Interrupción y concurrencia del entorno"
FAKE_BUILD_SLEEP=8000 bash "$HERE/local-build.sh" "$SHA1" "$F" "$OUTB" "$ER" > "$TMP/int.out" 2>&1 & BP=$!
for _ in $(seq 1 40); do [ -e "$W/.env.local" ] && break; sleep 0.5; done
check "durante el build existe .env.local (copiado) y el bloqueo" '[ -e "$W/.env.local" ] && [ -d "$ER/.lock" ]'
out="$(build "$SHA1")"; rc=$?
check "compilación simultánea => rechazada sin tocar el entorno ajeno" '[ $rc = 1 ] && grep -q "en uso por otra ejecución" <<< "$out" && [ -d "$ER/.lock" ] && [ -e "$W/.env.local" ]'
kill -TERM "$BP"; wait "$BP"; rc=$?
check "interrupción durante el build => sale con error, sin LISTO" '[ $rc != 0 ] && ! grep -q "^LISTO" "$TMP/int.out"'
check "tras la interrupción: sin .env.local, sin bloqueo, sólo node_modules" '[ ! -e "$W/.env.local" ] && [ ! -e "$ER/.lock" ] && only_node_modules'
out="$(build "$SHA1")"
check "la siguiente compilación funciona y reutiliza dependencias" 'grep -q "^dependencias=reutilizadas" <<< "$out" && grep -q "^LISTO" <<< "$out"'
bash -c 'exit 0' & DEAD=$!; wait "$DEAD"
mkdir "$ER/.lock" && echo "$DEAD" > "$ER/.lock/pid"
out="$(build "$SHA1")"
check "bloqueo abandonado (proceso muerto) => se recupera" 'grep -q "bloqueo abandonado" <<< "$out" && grep -q "^LISTO" <<< "$out"'
out="$(FAKE_BUILD_LEAK=1 build "$SHA1")"; rc=$?
check "build que mete un .env en .next => rechazado" '[ $rc = 1 ] && grep -q "contiene archivos .env" <<< "$out"'
check "y aun así no deja .env.local ni bloqueo" '[ ! -e "$W/.env.local" ] && [ ! -e "$ER/.lock" ] && only_node_modules'
check "dir-entorno con otro nombre => rechazado" '! bash "$HERE/local-build.sh" "$SHA1" "$F" "$OUTB" "$TMP/otro" >/dev/null 2>&1 && [ ! -e "$TMP/otro" ]'

echo "8. Aprobación de validaciones por commit"
AP="$TMP/aprobaciones"
ID1="$(approval_identity "$F" "$SHA1")"
check "identidad completa (12 claves, sin secretos en claro)" '[ "$(wc -l <<< "$ID1")" = 12 ] && ! grep -q "valor-de-prueba" <<< "$ID1"'
check "sin aprobación previa => no reutiliza" '! approval_check "$AP" "$SHA1" "$ID1" >/dev/null'
approval_save "$AP" "$SHA1" "$ID1" "C:\\log.txt"
check "aprobación guardada y válida => reutiliza" 'approval_check "$AP" "$SHA1" "$ID1" >/dev/null'
check "nunca se reutiliza para otro commit" '! approval_check "$AP" "$SHA2" "$(approval_identity "$F" "$SHA2")" >/dev/null'
echo 'OTRA=1' >> "$F/.env.local"
check "cambia .env.local => no reutiliza (env_local)" '[ "$(approval_check "$AP" "$SHA1" "$(approval_identity "$F" "$SHA1")")" = "cambió: env_local" ]'
sed -i '$d' "$F/.env.local"
cp "$F/node_modules/.package-lock.json" "$TMP/pl.bak"; echo ' ' >> "$F/node_modules/.package-lock.json"
check "cambian dependencias instaladas => no reutiliza" '[ "$(approval_check "$AP" "$SHA1" "$(approval_identity "$F" "$SHA1")")" = "cambió: dependencias_instaladas" ]'
cp "$TMP/pl.bak" "$F/node_modules/.package-lock.json"
check "cambia NODE_OPTIONS => no reutiliza" '[ "$(approval_check "$AP" "$SHA1" "$(NODE_OPTIONS=--no-warnings approval_identity "$F" "$SHA1")")" = "cambió: entorno_proceso" ]'
check "node inutilizable => identidad indeterminada (nunca node vacío)" '! NODE_OPTIONS=--max-old-space-size=1 approval_identity "$F" "$SHA1" >/dev/null 2>&1'
check "commit sin package-lock => sin clave de dependencias" '! deps_key "$G" HEAD >/dev/null 2>&1'
check "cambian las validaciones exigidas => no reutiliza" '[ "$(VALIDATION_SPEC=otra; approval_check "$AP" "$SHA1" "$(approval_identity "$F" "$SHA1")")" = "cambió: validaciones" ]'
check "identidad restaurada => vuelve a reutilizar" 'approval_check "$AP" "$SHA1" "$(approval_identity "$F" "$SHA1")" >/dev/null'
AF="$(approval_file "$AP" "$SHA1")"; cp "$AF" "$TMP/ap.bak"
sed -i 's/^resultado=aprobado/resultado=fallido/' "$AF"
check "archivo editado (resultado) => control inválido" '[ "$(approval_check "$AP" "$SHA1" "$ID1")" = "aprobación dañada o editada (control inválido)" ]'
cp "$TMP/ap.bak" "$AF"; sed -i 's/^node=.*/node=v0/' "$AF"
check "archivo editado (identidad) => control inválido" '! approval_check "$AP" "$SHA1" "$ID1" >/dev/null'
cp "$TMP/ap.bak" "$AF"; head -n 4 "$TMP/ap.bak" > "$AF"
check "archivo truncado => no reutiliza" '! approval_check "$AP" "$SHA1" "$ID1" >/dev/null'
cp "$TMP/ap.bak" "$AF"
approval_revoke "$AP" "$SHA1"
check "validación iniciada (se revoca antes) e interrumpida => no queda aprobación" '[ ! -e "$AF" ] && ! approval_check "$AP" "$SHA1" "$ID1" >/dev/null'
check "identidad indeterminable (sin .env.local) => error" '! (mv "$F/.env.local" "$TMP/env.bak"; approval_identity "$F" "$SHA1" >/dev/null; rc=$?; mv "$TMP/env.bak" "$F/.env.local"; exit $rc)'
check "identidad con SHA inválido => error" '! approval_identity "$F" HEAD >/dev/null'

echo "9. Argumentos nuevos y formato de tiempos"
for bad in "--estado --validacion-completa" "--validacion-completa --estado" "--solo-preparar --validacion-completa x" "--validacion-completa --rollback" "--solo-preparar x"; do
  # shellcheck disable=SC2086
  out="$(bash "$HERE/deploy.sh" $bad 2>&1)"; rc=$?
  if [ $rc = 2 ] && grep -q "^uso:" <<< "$out"; then ok "rechaza: $bad"; else ko "aceptó: $bad (rc=$rc)"; fi
done
check "fmt_ms 1234 => 1,2 s" '[ "$(fmt_ms 1234)" = "1,2 s" ]'
check "fmt_ms 1256000 => 20 min 56 s" '[ "$(fmt_ms 1256000)" = "20 min 56 s" ]'

# ── Integridad de dependencias por contenido ───────────────────────────────────
# Huella anterior (rutas + tamaños), sólo para demostrar qué cambios no detectaba.
old_fingerprint() { (cd "$1" && find node_modules -path node_modules/.cache -prune -o -type f -printf '%P\t%s\n' | LC_ALL=C sort | sha256_of); }
junction() { node -e 'require("fs").symlinkSync(process.argv[1], process.argv[2], "junction")' "$(cygpath -w "$1")" "$(cygpath -w "$2")"; }
fp() { deps_fingerprint "$1" | cut -d' ' -f1; }
stamp_print() { sed -n 's/^huella=//p' "$ER/deps.stamp" | cut -d' ' -f1; }

echo "10. Integridad de node_modules (entorno de compilación)"
out="$(build "$SHA1")"
check "punto de partida: instalación legítima reutilizada y con integridad" 'grep -q "^dependencias=reutilizadas" <<< "$out" && grep -qE "^integridad_dependencias=[0-9a-f]{64} archivos=" <<< "$out"'
DEPF="$W/node_modules/dep/index.js"
old_before="$(old_fingerprint "$W")"; touch -r "$DEPF" "$TMP/mtime.ref"
sed -i 's/= 1/= 2/' "$DEPF"; touch -r "$TMP/mtime.ref" "$DEPF"
check "(1) mismo tamaño y misma fecha: la huella vieja NO lo detectaba" '[ "$(old_fingerprint "$W")" = "$old_before" ] && grep -q "= 2" "$DEPF"'
check "(1) mismo tamaño y misma fecha: la huella por contenido sí" '[ "$(fp "$W")" != "$(stamp_print)" ]'
out="$(build "$SHA1")"; rc=$?
check "(1) contenido alterado => reinstala y restaura el original" '[ $rc = 0 ] && grep -q "contenido distinto" <<< "$out" && grep -q "^dependencias=instaladas" <<< "$out" && grep -q "= 1" "$DEPF"'
echo 'module.exports = "inyectado"' > "$W/node_modules/dep/extra.js"
out="$(build "$SHA1")"
check "(2) archivo agregado => reinstala y lo elimina" 'grep -q "contenido distinto" <<< "$out" && [ ! -e "$W/node_modules/dep/extra.js" ]'
mkdir "$W/node_modules/dep/vacio"
out="$(build "$SHA1")"
check "(2) directorio vacío agregado => reinstala" 'grep -q "contenido distinto" <<< "$out" && [ ! -e "$W/node_modules/dep/vacio" ]'
rm -f "$W/node_modules/dep/package.json"
out="$(build "$SHA1")"
check "(3) archivo eliminado => reinstala" 'grep -q "contenido distinto" <<< "$out" && [ -f "$W/node_modules/dep/package.json" ]'
junction "$W/node_modules/dep" "$W/node_modules/enlace"
out="$(build "$SHA1")"
check "(4) enlace agregado dentro de node_modules => reinstala" 'grep -q "contenido distinto" <<< "$out" && [ ! -e "$W/node_modules/enlace" ]'
mkdir -p "$TMP/afuera"; echo 'module.exports = "afuera"' > "$TMP/afuera/index.js"
junction "$TMP/afuera" "$W/node_modules/enlace"
out="$(build "$SHA1")"
check "(4) enlace hacia afuera de node_modules => integridad no comprobable => reinstala" 'grep -q "no se pudo comprobar la integridad" <<< "$out" && grep -q "^dependencias=instaladas" <<< "$out" && [ ! -e "$W/node_modules/enlace" ] && [ -f "$TMP/afuera/index.js" ]'

echo "11. Enlaces simbólicos y sus destinos (huella directa)"
L="$TMP/links"; mkdir -p "$L/node_modules/a" "$L/node_modules/b"
echo 'x' > "$L/node_modules/a/f.js"; echo 'x' > "$L/node_modules/b/f.js"
junction "$L/node_modules/a" "$L/node_modules/l"
l1="$(fp "$L")"
check "huella con enlace interno calculable y estable" '[ -n "$l1" ] && [ "$(fp "$L")" = "$l1" ] && grep -q " enlaces=1 " <<< "$(deps_fingerprint "$L")"'
rm "$L/node_modules/l"; junction "$L/node_modules/b" "$L/node_modules/l"
check "(4) enlace redirigido a otro destino (mismo contenido) => huella distinta" '[ "$(fp "$L")" != "$l1" ]'
rm "$L/node_modules/l"; junction "$TMP/afuera" "$L/node_modules/l"
check "(4) enlace redirigido hacia afuera => falla sin imprimir huella" '! out="$(deps_fingerprint "$L")" && [ -z "$out" ]'
rm "$L/node_modules/l"; junction "$L/node_modules/a" "$L/node_modules/l"; rm -rf "$L/node_modules/a"
check "enlace colgante => huella distinta (no se ignora)" 'l3="$(fp "$L")" && [ -n "$l3" ] && [ "$l3" != "$l1" ]'
rm -rf "$L/node_modules/l"
junction "$L/node_modules" "$L/node_modules/b/ciclo"
check "enlace cíclico => no se sigue, termina" 'timeout 30 bash -c ". \"$HERE/lib.sh\"; deps_fingerprint \"$L\" >/dev/null"'
check "node_modules que es un enlace => no verificable" 'mkdir -p "$TMP/raiz-enlace" && junction "$L/node_modules" "$TMP/raiz-enlace/node_modules" && ! deps_fingerprint "$TMP/raiz-enlace" >/dev/null'
check "sin node_modules => no verificable" '! deps_fingerprint "$TMP/no-existe" >/dev/null'

echo "12. Caché incompleta o corrupta e interrupción"
out="$(build "$SHA1")"
sed -i 's/^huella=.*/huella=/' "$ER/deps.stamp"
out="$(build "$SHA1")"
check "(6) sello con huella vacía => reinstala (nunca compara vacío con vacío)" 'grep -q "sello incompleto o corrupto" <<< "$out" && grep -q "^dependencias=instaladas" <<< "$out"'
sed -i '/^huella=/d' "$ER/deps.stamp"
out="$(build "$SHA1")"
check "(6) sello sin huella => reinstala" 'grep -q "sello incompleto o corrupto" <<< "$out"'
printf 'huella=%s\n' "$(deps_fingerprint "$W")" >> "$ER/deps.stamp"
out="$(build "$SHA1")"
check "(6) sello con huella duplicada => reinstala" 'grep -q "sello incompleto o corrupto" <<< "$out"'
rm -rf "$W/node_modules/dep"
out="$(build "$SHA1")"
check "(6) paquete entero borrado => reinstala" 'grep -q "contenido distinto" <<< "$out" && [ -f "$W/node_modules/dep/index.js" ]'
echo "huella=$(stamp_print)" > "$ER/deps.stamp.tmp"; rm -f "$ER/deps.stamp"
out="$(build "$SHA1")"
check "(6/7) sello temporal de una escritura interrumpida => se ignora, reinstala" 'grep -q "sin instalación previa válida" <<< "$out"'
FAKE="$TMP/fake-lib"; mkdir -p "$FAKE"
printf 'process.stdout.write("abc archivos=1")\n' > "$FAKE/deps-fingerprint.mjs"
check "(7) salida parcial o malformada del cálculo => no hay huella" '! (DEPLOY_LIB_DIR="$FAKE"; deps_fingerprint "$W") >/dev/null'
printf 'process.stdout.write("%s archivos=1 enlaces=0 bytes=1\\n"); process.exit(1)\n' "$(printf 'a%.0s' $(seq 64))" > "$FAKE/deps-fingerprint.mjs"
check "(7) cálculo que termina con error aunque imprima algo => no hay huella" '! (DEPLOY_LIB_DIR="$FAKE"; deps_fingerprint "$W") >/dev/null'
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
if [ -d "$REPO_ROOT/node_modules" ]; then
  node "$HERE/deps-fingerprint.mjs" "$REPO_ROOT/node_modules" > "$TMP/int-fp.out" 2>"$TMP/int-fp.err" & FPP=$!
  sleep 1; kill -TERM "$FPP" 2>/dev/null; wait "$FPP"; rc=$?
  check "(7) cálculo interrumpido (node_modules real) => sin huella y código != 0" '[ $rc != 0 ] && [ ! -s "$TMP/int-fp.out" ]'
else
  ko "(7) no hay node_modules en el repo para la prueba de interrupción"
fi

echo "13. Aprobaciones atadas al contenido de las dependencias"
AP2="$TMP/aprobaciones2"
IDB="$(approval_identity "$F" "$SHA1")"
check "(8) dependencias legítimas sin cambios: identidad estable" '[ -n "$IDB" ] && [ "$(approval_identity "$F" "$SHA1")" = "$IDB" ] && grep -qE "^dependencias_contenido=[0-9a-f]{64} archivos=" <<< "$IDB"'
approval_save "$AP2" "$SHA1" "$IDB" "C:\\log.txt"
check "(8) dependencias legítimas sin cambios: reutiliza" 'approval_check "$AP2" "$SHA1" "$(approval_identity "$F" "$SHA1")" >/dev/null'
FD="$F/node_modules/dep/index.js"; cp "$FD" "$TMP/fd.bak"; touch -r "$FD" "$TMP/fd.ref"
sed -i 's/= 1/= 3/' "$FD"; touch -r "$TMP/fd.ref" "$FD"
check "(5) contenido alterado tras aprobar (mismo tamaño, fecha y .package-lock) => no reutiliza" '[ "$(approval_check "$AP2" "$SHA1" "$(approval_identity "$F" "$SHA1")")" = "cambió: dependencias_contenido" ]'
cp "$TMP/fd.bak" "$FD"
check "(5) al restaurar el contenido exacto vuelve a reutilizar" 'approval_check "$AP2" "$SHA1" "$(approval_identity "$F" "$SHA1")" >/dev/null'
echo 'x' > "$F/node_modules/dep/agregado.js"
check "(2) archivo agregado a node_modules del repo => no reutiliza" '[ "$(approval_check "$AP2" "$SHA1" "$(approval_identity "$F" "$SHA1")")" = "cambió: dependencias_contenido" ]'
rm -f "$F/node_modules/dep/agregado.js"
mv "$F/node_modules/dep/package.json" "$TMP/dep-pkg.bak"
check "(3) archivo eliminado de node_modules del repo => no reutiliza" '[ "$(approval_check "$AP2" "$SHA1" "$(approval_identity "$F" "$SHA1")")" = "cambió: dependencias_contenido" ]'
mv "$TMP/dep-pkg.bak" "$F/node_modules/dep/package.json"
junction "$F/node_modules/dep" "$F/node_modules/enlace"
check "(4) enlace agregado a node_modules del repo => no reutiliza" '[ "$(approval_check "$AP2" "$SHA1" "$(approval_identity "$F" "$SHA1")")" = "cambió: dependencias_contenido" ]'
rm "$F/node_modules/enlace"; junction "$TMP/afuera" "$F/node_modules/enlace"
check "(4) enlace hacia afuera en el repo => identidad indeterminada (validación completa)" '! approval_identity "$F" "$SHA1" >/dev/null'
rm "$F/node_modules/enlace"
# Flujo de deploy.sh: identidad antes de validar vs. después; una alteración durante la validación impide guardar.
BEFORE="$(approval_identity "$F" "$SHA1")"; sed -i 's/= 1/= 4/' "$FD"; AFTER="$(approval_identity "$F" "$SHA1")" || AFTER=""
check "(5) alteración DURANTE la validación => identidad posterior distinta (no se guarda)" '[ -n "$BEFORE" ] && [ "$AFTER" != "$BEFORE" ]'
cp "$TMP/fd.bak" "$FD"
check "aprobación con esquema anterior (sin contenido) => no reutiliza" '[ "$(approval_save "$AP2" "$SHA1" "$(sed "/^dependencias_contenido=/d; s/^esquema=.*/esquema=1/" <<< "$IDB")" x; approval_check "$AP2" "$SHA1" "$IDB")" = "cambió: esquema" ]'

echo "14. Concurrencia"
fp_a="$TMP/fp-a"; fp_b="$TMP/fp-b"
deps_fingerprint "$W" > "$fp_a" & PA=$!; deps_fingerprint "$W" > "$fp_b" & PB=$!
wait "$PA"; ra=$?; wait "$PB"; rb=$?
check "(9) dos cálculos simultáneos => mismo resultado completo" '[ $ra = 0 ] && [ $rb = 0 ] && [ -s "$fp_a" ] && cmp -s "$fp_a" "$fp_b"'
approval_save "$AP2" "$SHA1" "$IDB" "C:\\a.txt" & PA=$!; approval_save "$AP2" "$SHA1" "$IDB" "C:\\b.txt" & PB=$!
wait "$PA"; wait "$PB"
check "(9) dos aprobaciones simultáneas => archivo íntegro, sin temporales" 'approval_check "$AP2" "$SHA1" "$IDB" >/dev/null && [ -z "$(ls "$AP2" | grep "\.tmp\.")" ]'
FAKE_BUILD_SLEEP=6000 bash "$HERE/local-build.sh" "$SHA1" "$F" "$OUTB" "$ER" > "$TMP/c1.out" 2>&1 & PA=$!
for _ in $(seq 1 40); do [ -d "$ER/.lock" ] && break; sleep 0.25; done
bash "$HERE/local-build.sh" "$SHA1" "$F" "$OUTB" "$ER" > "$TMP/c2.out" 2>&1; rb=$?
wait "$PA"; ra=$?
check "(9) dos compilaciones simultáneas => una termina, la otra rechazada sin tocar el entorno" '[ $ra = 0 ] && grep -q "^LISTO" "$TMP/c1.out" && [ $rb = 1 ] && grep -q "en uso por otra ejecución" "$TMP/c2.out"'
out="$(build "$SHA1")"
check "(9) tras la concurrencia el entorno sigue íntegro y se reutiliza" 'grep -q "^dependencias=reutilizadas" <<< "$out"'

echo "15. package.json cambia sin cambiar package-lock"
(cd "$F" && node -e '
  const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json", "utf8"))
  p.scripts.postinstall = "node -e \"require(\x27fs\x27).writeFileSync(\x27node_modules/.postinstall\x27, \x27v2\x27)\""
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n")' \
  && git add package.json && git -c user.email=t@t -c user.name=t commit -qm postinstall)
SHA3="$(git -C "$F" rev-parse HEAD)"
check "el commit cambia package.json y NO package-lock" 'git -C "$F" diff --quiet "$SHA2" "$SHA3" -- package-lock.json && ! git -C "$F" diff --quiet "$SHA2" "$SHA3" -- package.json'
check "con la clave anterior (sólo lock) ambos commits parecían iguales" '[ "$(git -C "$F" show "$SHA2:package-lock.json" | sha256_of)" = "$(git -C "$F" show "$SHA3:package-lock.json" | sha256_of)" ]'
check "la clave nueva los distingue" '[ "$(deps_key "$F" "$SHA2")" != "$(deps_key "$F" "$SHA3")" ]'
out="$(build "$SHA2")"
check "el entorno queda con la instalación válida del lock compartido (SHA2)" 'grep -q "^LISTO" <<< "$out" && [ ! -e "$W/node_modules/.postinstall" ]'
out="$(build "$SHA3")"; rc=$?
check "(10) script de instalación nuevo => reinstala y npm ci lo ejecuta (reutilizar lo habría omitido)" '[ $rc = 0 ] && grep -q "cambió package-lock, package.json" <<< "$out" && [ "$(cat "$W/node_modules/.postinstall" 2>/dev/null)" = v2 ]'
(cd "$F" && node -e '
  const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json", "utf8"))
  p.dependencies["no-declarada-en-lock"] = "1.0.0"
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n")' \
  && git add package.json && git -c user.email=t@t -c user.name=t commit -qm desincronizado)
SHA4="$(git -C "$F" rev-parse HEAD)"
out="$(build "$SHA4")"; rc=$?
check "(10) dependencia nueva sin actualizar el lock => npm ci la rechaza (reutilizar la habría ocultado)" '[ $rc = 1 ] && grep -q "cambió package-lock, package.json" <<< "$out" && grep -q "npm ci falló" <<< "$out"'
check "(10) tras el npm ci fallido no queda sello reutilizable" '[ ! -e "$ER/deps.stamp" ] && [ ! -e "$ER/.lock" ]'
out="$(build "$SHA1")"; rc=$?
check "volver a un commit sano => instala limpio y funciona" '[ $rc = 0 ] && grep -q "^dependencias=instaladas" <<< "$out" && [ ! -e "$W/node_modules/.postinstall" ]'

echo
echo "RESULTADO LOCAL: $PASS OK, $FAIL fallos"
[ "$FAIL" = 0 ]
