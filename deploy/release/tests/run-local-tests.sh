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
check "identidad completa (13 claves, sin secretos en claro)" '[ "$(wc -l <<< "$ID1")" = 13 ] && ! grep -q "valor-de-prueba" <<< "$ID1"'
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

echo "16. Niveles de validación: estándar (sin npm test) y completa (con npm test)"
check "nivel estándar: lint + typecheck, sin npm test" '[ "$(validation_spec estandar)" = "lint=npm run lint|typecheck=npm run typecheck" ]'
check "nivel completa: incluye npm test" 'grep -q "tests=npm test" <<< "$(validation_spec completa)"'
check "nivel inválido => rechazado" '! validation_spec otro >/dev/null && ! approval_file "$TMP" "$SHA1" otro >/dev/null && ! approval_identity "$F" "$SHA1" otro >/dev/null'
BASE16="$(approval_base_identity "$F" "$SHA1")"
IDE="$(approval_with_level "$BASE16" estandar)"; IDC="$(approval_with_level "$BASE16" completa)"
check "identidades de cada nivel difieren sólo en nivel y validaciones" '[ "$(diff <(echo "$IDE") <(echo "$IDC") | grep -c "^[<>]")" = 4 ] && grep -qx "nivel=estandar" <<< "$IDE" && grep -qx "nivel=completa" <<< "$IDC"'
check "approval_identity sin nivel = estándar" '[ "$(approval_identity "$F" "$SHA1")" = "$IDE" ]'
check "cada nivel tiene su propio archivo" '[ "$(approval_file "$TMP" "$SHA1" estandar)" != "$(approval_file "$TMP" "$SHA1" completa)" ]'
AP3="$TMP/aprobaciones3"
check "no se guarda una identidad bajo otro nivel (estándar como completa)" '! approval_save "$AP3" "$SHA1" "$IDE" x completa && [ ! -e "$(approval_file "$AP3" "$SHA1" completa)" ]'
approval_save "$AP3" "$SHA1" "$IDE" "C:\\std.txt" estandar
check "aprobación estándar NO sirve como completa" '[ "$(approval_check "$AP3" "$SHA1" "$IDC" completa)" = "sin aprobación previa para este commit" ]'
cp "$(approval_file "$AP3" "$SHA1" estandar)" "$(approval_file "$AP3" "$SHA1" completa)"
check "aprobación estándar copiada al archivo completo => rechazada (cambió: nivel)" '[ "$(approval_check "$AP3" "$SHA1" "$IDC" completa)" = "cambió: nivel" ]'
check "approval_check con identidad de otro nivel => rechazada" '[ "$(approval_check "$AP3" "$SHA1" "$IDC" estandar)" = "identidad de otro nivel de validación" ]'
check "deploy estándar con aprobación estándar (y completa falsa) => reutiliza ESTÁNDAR, no completa" '[ "$(approval_pick "$AP3" "$SHA1" "$BASE16" 2>/dev/null)" = estandar ]'
approval_save "$AP3" "$SHA1" "$IDC" "C:\\full.txt" completa
check "deploy estándar con aprobación completa válida => la reutiliza como completa" '[ "$(approval_pick "$AP3" "$SHA1" "$BASE16" 2>/dev/null)" = completa ]'
approval_revoke "$AP3" "$SHA1" estandar
check "revocar el nivel estándar no toca la aprobación completa" '[ ! -e "$(approval_file "$AP3" "$SHA1" estandar)" ] && approval_check "$AP3" "$SHA1" "$IDC" completa >/dev/null'
approval_revoke "$AP3" "$SHA1" completa
check "sin aprobaciones => no reutiliza y explica ambos niveles" '! approval_pick "$AP3" "$SHA1" "$BASE16" 2>"$TMP/pick.err" >/dev/null && grep -q "^completa: sin aprobación" "$TMP/pick.err" && grep -q "^estandar: sin aprobación" "$TMP/pick.err"'
check "identidad base indeterminada => no reutiliza" '! approval_pick "$AP3" "$SHA1" "" 2>/dev/null'
approval_save "$AP3" "$SHA1" "$IDE" x estandar
FD16="$F/node_modules/dep/index.js"; cp "$FD16" "$TMP/fd16.bak"; sed -i 's/= 1/= 5/' "$FD16"
check "aprobación estándar con dependencias alteradas => no reutiliza" '! approval_pick "$AP3" "$SHA1" "$(approval_base_identity "$F" "$SHA1")" 2>/dev/null'
cp "$TMP/fd16.bak" "$FD16"
check "aprobación de schema 2 (archivo <sha>.aprobacion, incluía tests) ya no se lee" '[ "$(basename "$(approval_file "$AP3" "$SHA1")")" = "$SHA1.estandar.aprobacion" ]'

# validate_commit sobre un proyecto falso: cada script deja una marca; ningún test real de BEYONIX se ejecuta.
V="$TMP/val"; mkdir -p "$V"
cat > "$V/package.json" <<'JSON'
{ "name": "val", "version": "1.0.0", "private": true,
  "scripts": {
    "lint": "node -e \"require('fs').appendFileSync('marcas', 'lint\\n'); process.exit(process.env.FAIL_LINT ? 1 : 0)\"",
    "typecheck": "node -e \"require('fs').appendFileSync('marcas', 'typecheck\\n')\"",
    "test": "node -e \"require('fs').appendFileSync('marcas', 'test\\n'); process.exit(process.env.FAIL_TEST ? 1 : 0)\"" } }
JSON
VLOG="$TMP/val.log"
: > "$VLOG"; rm -f "$V/marcas"
vout="$(validate_commit "$V" estandar "$VLOG")"; rc=$?
check "estándar: ejecuta lint y typecheck" '[ $rc = 0 ] && grep -qx lint "$V/marcas" && grep -qx typecheck "$V/marcas"'
check "estándar: NO ejecuta npm test" '! grep -qx test "$V/marcas" && grep -q "npm test omitido (validación estándar)" "$VLOG"'
check "estándar: tiempos de lint y typecheck, ninguno de tests" 'grep -qE "^tiempo lint=[0-9]+$" <<< "$vout" && grep -qE "^tiempo typecheck=[0-9]+$" <<< "$vout" && ! grep -q "^tiempo tests=" <<< "$vout"'
: > "$VLOG"; rm -f "$V/marcas"
vout="$(validate_commit "$V" completa "$VLOG")"; rc=$?
check "completa: ejecuta lint, typecheck y npm test" '[ $rc = 0 ] && [ "$(tr "\n" " " < "$V/marcas")" = "lint typecheck test " ] && grep -qE "^tiempo tests=[0-9]+$" <<< "$vout"'
rm -f "$V/marcas"
FAIL_TEST=1 validate_commit "$V" completa "$VLOG" >/dev/null; rc=$?
check "completa: npm test fallido => código 12 (nunca aprobado)" '[ $rc = 12 ]'
rm -f "$V/marcas"
FAIL_LINT=1 validate_commit "$V" estandar "$VLOG" >/dev/null; rc=$?
check "lint fallido => código 10 y no sigue con typecheck" '[ $rc = 10 ] && ! grep -qx typecheck "$V/marcas"'
validate_commit "$V" otro "$VLOG" >/dev/null; rc=$?
check "nivel inválido => código 2 sin ejecutar nada" '[ $rc = 2 ]'

# Conexión deploy-beyonix.ps1 -> deploy.sh -> validate_commit (estática: no se ejecuta un deploy real).
DS="$HERE/deploy.sh"; PS1="$HERE/../../deploy-beyonix.ps1"
check "deploy.sh: el nivel por defecto es estándar y --validacion-completa lo cambia a completa" 'grep -qx "VALIDATION_LEVEL=estandar" "$DS" && grep -qx "\[ \"\$FORCE_VALIDATION\" = 1 \] && VALIDATION_LEVEL=completa" "$DS"'
check "deploy.sh: valida sólo mediante validate_commit con ese nivel (sin npm test directo)" 'grep -q "validate_commit \"\$REPO\" \"\$VALIDATION_LEVEL\" \"\$LOG\"" "$DS" && ! grep -qE "^[^#]*(run_with_tree_timeout|run timeout [0-9]+ npm|npm test\b[^\"]*\$)" "$DS"'
check "deploy.sh: revoca TODOS los niveles antes de validar y registra sólo lo demostrado" 'grep -q "approval_revoke_all \"\$APPROVALS\" \"\$SHA\"" "$DS" && grep -q "approval_record \"\$APPROVALS\" \"\$SHA\" \"\$VALIDATION_LEVEL\" \"\$VAL_RC\"" "$DS" && ! grep -qE "^[^#]*approval_(save|revoke) " "$DS"'
check "deploy.sh: la validación completa nunca reutiliza aprobaciones" 'grep -q "if \[ \"\$VALIDATION_LEVEL\" = completa \]; then" "$DS" && grep -B1 -A1 "validación completa solicitada" "$DS" | grep -q "VALIDATION_LEVEL\" = completa"'
check "deploy-beyonix.ps1: -ValidacionCompleta es el único que pasa --validacion-completa" '[ "$(grep -c -- "--validacion-completa" "$PS1")" = 1 ] && grep -q "if (\$ValidacionCompleta) { \$argumentos += .--validacion-completa. }" "$PS1"'
echo "17. Registro de aprobaciones tras cada resultado (approval_record)"
AP4="$TMP/aprobaciones4"
B17="$(approval_base_identity "$F" "$SHA1")"
seed_both() { approval_save "$AP4" "$SHA1" "$(approval_with_level "$B17" estandar)" x estandar && approval_save "$AP4" "$SHA1" "$(approval_with_level "$B17" completa)" x completa; }
has() { approval_check "$AP4" "$SHA1" "$(approval_with_level "$B17" "$1")" "$1" >/dev/null; }
seed_both; approval_revoke_all "$AP4" "$SHA1"
check "approval_revoke_all borra ambos niveles" '! has estandar && ! has completa'
for rc in 10 11 2 1; do
  seed_both; approval_revoke_all "$AP4" "$SHA1"
  approval_record "$AP4" "$SHA1" completa "$rc" "$B17" "$B17" x >/dev/null
  check "completa con rc=$rc (lint/typecheck fallido o error) => ninguna aprobación" '! has estandar && ! has completa'
done
for rc in 12 124 125; do
  approval_revoke_all "$AP4" "$SHA1"
  out="$(approval_record "$AP4" "$SHA1" completa "$rc" "$B17" "$B17" x)"
  check "completa con rc=$rc (sólo fallaron/cortaron tests) => sólo estándar (lint y typecheck pasaron)" '[ "$out" = estandar ] && has estandar && ! has completa'
done
approval_revoke_all "$AP4" "$SHA1"
out="$(approval_record "$AP4" "$SHA1" completa 0 "$B17" "$B17" x)"
check "(6) completa exitosa => estándar y completa consistentes" '[ "$(tr "\n" " " <<< "$out")" = "estandar completa " ] && has estandar && has completa'
approval_revoke_all "$AP4" "$SHA1"
out="$(approval_record "$AP4" "$SHA1" estandar 0 "$B17" "$B17" x)"
check "estándar exitosa => sólo estándar (nunca completa)" '[ "$out" = estandar ] && has estandar && ! has completa'
approval_revoke_all "$AP4" "$SHA1"
check "estándar con rc=12 imposible de elevar a completa" '[ "$(approval_record "$AP4" "$SHA1" estandar 12 "$B17" "$B17" x)" = estandar ] && ! has completa'
approval_revoke_all "$AP4" "$SHA1"
check "identidad cambiada durante la validación => no guarda nada" '! approval_record "$AP4" "$SHA1" completa 0 "$B17" "${B17/esquema=/esquema=x}" x >/dev/null && ! has estandar && ! has completa'
check "identidad posterior indeterminada => no guarda nada" '! approval_record "$AP4" "$SHA1" completa 0 "$B17" "" x >/dev/null && ! has estandar'

# ── deploy.sh de punta a punta, aislado ────────────────────────────────────────
# ssh/scp/curl/npx son stubs locales: no hay red ni acceso al VPS, a PM2 ni a Supabase. HOME y
# USERPROFILE apuntan a directorios temporales (sin clave SSH real; logs/aprobaciones/build aislados).
echo "18. deploy.sh aislado: commit activo, -ValidacionCompleta e invalidación de aprobaciones"
E="$TMP/e2e"; ST="$E/stubs"; R="$E/repo"; mkdir -p "$ST" "$E/home" "$E/perfil"
export E2E_DIR="$E"
cat > "$ST/ssh" <<'SH'
#!/usr/bin/env bash
body="$(cat)"
case "$body" in
  *'echo "public_env_hash='*)
    echo "status" >> "$E2E_DIR/ssh.log"
    [ -f "$E2E_DIR/status.extra" ] && cat "$E2E_DIR/status.extra"
    printf 'pm2_status=online\npm2_cwd=/home/beyonix/apps/beyonix-current\nlocal_home=200\nswitch_lock=libre\n'
    printf 'active_target=/home/beyonix/apps/beyonix-releases/1234567-20260101-000000\nactive_build=build-activo\n'
    printf 'disk_free_mb=%s\nmem_available_mb=2000\nactive_sha=%s\npublic_env_hash=%s\n' "$(cat "$E2E_DIR/disk_free" 2>/dev/null || echo 9000)" "$(cat "$E2E_DIR/active_sha")" "$(cat "$E2E_DIR/public_hash")" ;;
  *'LIMPIEZA resultado='*)
    # remote-cleanup.sh falso: registra los argumentos y "libera" lo indicado en cleanup_frees.
    echo "cleanup ${@: -1}" >> "$E2E_DIR/ssh.log"
    [ -f "$E2E_DIR/cleanup_frees" ] && cp "$E2E_DIR/cleanup_frees" "$E2E_DIR/disk_free"
    [ "$(cat "$E2E_DIR/cleanup_result" 2>/dev/null)" = ocupado ] && echo "OCUPADO: hay un cambio de versión en curso; no se borra nada"
    # Como remote-cleanup.sh real: rollback registrado ausente/inválido => DETENER, rc 1, sin plan.
    if [ "$(cat "$E2E_DIR/cleanup_result" 2>/dev/null)" = rollback_invalido ]; then
      echo "DETENER: la release de rollback registrada (/home/beyonix/apps/beyonix-releases/919a98b-20261123-194830) no existe o no es válida (no existe); no se borra nada"
      exit 1
    fi
    printf 'ELIMINAR vieja-1 mb=1100 motivo=vieja\nLIMPIEZA resultado=%s eliminadas=2 liberado_mb=2200 libre_mb=%s liberable_mb=2200\n' \
      "$(cat "$E2E_DIR/cleanup_result" 2>/dev/null || echo ok)" "$(cat "$E2E_DIR/disk_free" 2>/dev/null || echo 9000)"
    exit "$(cat "$E2E_DIR/cleanup_rc" 2>/dev/null || echo 0)" ;;
  *) echo "NO-PERMITIDO ssh $*" | tee -a "$E2E_DIR/todo.log" >> "$E2E_DIR/ssh.log"; exit 97 ;;
esac
SH
for c in scp curl; do
  printf '#!/usr/bin/env bash\necho "NO-PERMITIDO %s $*" | tee -a "$E2E_DIR/todo.log" >> "$E2E_DIR/ssh.log"; exit 97\n' "$c" > "$ST/$c"
done
cat > "$ST/npx" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *" supabase db query "*) cat "$E2E_DIR/migraciones.json" ;;
  *) echo "NO-PERMITIDO npx $*" | tee -a "$E2E_DIR/todo.log" >> "$E2E_DIR/ssh.log"; exit 97 ;;
esac
SH
chmod +x "$ST"/*
mkdir -p "$R"; git init -q -b main "$R"; git init -q --bare "$E/origin.git"
cat > "$R/v.js" <<'JS'
const fs = require("fs"), step = process.argv[2]
fs.appendFileSync(process.env.E2E_DIR + "/marcas", step + "\n")
if (process.env["FAIL_" + step.toUpperCase()]) process.exit(1)
if (step === "test" && process.env.E2E_SLEEP_TEST) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.E2E_SLEEP_TEST))
JS
cat > "$R/package.json" <<'JSON'
{ "name": "e2e", "version": "1.0.0", "private": true,
  "scripts": { "lint": "node v.js lint", "typecheck": "node v.js typecheck", "test": "node v.js test", "build": "node -e \"process.exit(1)\"" } }
JSON
printf '{"name":"e2e","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"e2e","version":"1.0.0"}}}\n' > "$R/package-lock.json"
mkdir -p "$R/supabase/migrations" "$R/supabase/.temp" "$R/node_modules/x"
echo 'select 1;' > "$R/supabase/migrations/20260101000000_init.sql"
echo 'ref' > "$R/supabase/.temp/project-ref"
printf 'node_modules/\n.env.local\nsupabase/.temp/\n' > "$R/.gitignore"
printf '{"name":"e2e","lockfileVersion":3,"packages":{}}\n' > "$R/node_modules/.package-lock.json"
echo 'module.exports = 1' > "$R/node_modules/x/index.js"
printf 'SECRETO=x\nNEXT_PUBLIC_X=1\n' > "$R/.env.local"
git -C "$R" add . && git -C "$R" -c user.email=t@t -c user.name=t commit -qm uno
git -C "$R" remote add origin "$E/origin.git" && git -C "$R" push -q origin main 2>/dev/null
RSHA="$(git -C "$R" rev-parse HEAD)"
grep -E '^NEXT_PUBLIC_[A-Z0-9_]*=' "$R/.env.local" | tr -d '\r' | sed -E 's/[[:space:]]+$//' | LC_ALL=C sort | sha256sum | cut -c1-16 > "$E/public_hash"
echo '[{"version":"20260101000000"}]' > "$E/migraciones.json"
EAP="$E/perfil/Documents/BEYONIX-backups/deploy-approvals"
EB="$E/perfil/Documents/BEYONIX-backups/build-env"
e2e() { # [argumentos de deploy.sh]; variables FAIL_*/E2E_SLEEP_TEST se pasan por entorno
  : > "$E/marcas"; : > "$E/ssh.log"
  PATH="$ST:$PATH" HOME="$E/home" USERPROFILE="$(cygpath -w "$E/perfil")" BEYONIX_DEPLOY_REPO="$R" \
    bash "$HERE/deploy.sh" "$@" 2>&1
}
marcas() { tr '\n' ' ' < "$E/marcas" | sed 's/ $//'; }
eh() { approval_check "$EAP" "$RSHA" "$(approval_identity "$R" "$RSHA" "$1")" "$1" >/dev/null; }
only_status_ssh() { [ -z "$(grep -v '^status$' "$E/ssh.log")" ]; }
no_build() { # en la última ejecución no se invocó local-build.sh
  local l; l="$(ls -t "$E/perfil/Documents/BEYONIX-backups/deploy-logs"/deploy-*.log | head -1)"
  [ -f "$l" ] && ! grep -q "local-build.sh" "$l"
}

if [ "$(PATH="$ST:$PATH" command -v ssh)" != "$ST/ssh" ] || [ "$(PATH="$ST:$PATH" command -v npx)" != "$ST/npx" ]; then
  ko "los stubs no tienen prioridad en PATH: se omite la prueba de punta a punta (nunca contra el VPS real)"
else
  echo "$RSHA" > "$E/active_sha"
  out="$(e2e)"; rc=$?
  check "(5) commit ya activo + deploy normal => termina sin validar ni desplegar" '[ $rc = 0 ] && grep -q "ya tiene esta versión" <<< "$out" && [ -z "$(marcas)" ] && only_status_ssh && no_build'
  out="$(e2e --validacion-completa)"; rc=$?
  check "(4) commit ya activo + -ValidacionCompleta => ejecuta lint, typecheck y npm test" '[ $rc = 0 ] && [ "$(marcas)" = "lint typecheck test" ] && grep -q "no se compiló ni se desplegó nada" <<< "$out" && grep -q "Validación: completa: ESLint + TypeScript + npm test" <<< "$out"'
  check "(4) ...sin compilar, transferir ni activar (sólo lectura de estado)" 'only_status_ssh && no_build'
  check "(6) validación completa exitosa => aprobaciones estándar y completa consistentes" 'eh estandar && eh completa'
  out="$(e2e --validacion-completa)"
  check "(4) -ValidacionCompleta nunca reutiliza: repite npm test aunque haya aprobación completa" '[ "$(marcas)" = "lint typecheck test" ] && ! grep -q "reutiliza" <<< "$out"'
  out="$(FAIL_LINT=1 e2e --validacion-completa)"; rc=$?
  check "(1) estándar existente + completa con ESLint fallido => ambas aprobaciones invalidadas" '[ $rc = 1 ] && grep -q "lint con errores" <<< "$out" && [ "$(marcas)" = lint ] && ! eh estandar && ! eh completa'
  e2e --validacion-completa >/dev/null
  out="$(FAIL_TYPECHECK=1 e2e --validacion-completa)"; rc=$?
  check "(2) estándar existente + completa con TypeScript fallido => ambas aprobaciones invalidadas" '[ $rc = 1 ] && grep -q "typecheck con errores" <<< "$out" && ! eh estandar && ! eh completa'
  echo 0000000000000000000000000000000000000000 > "$E/active_sha"
  out="$(e2e)"; rc=$?
  check "(3) tras la completa fallida, deploy normal => vuelve a ejecutar lint y typecheck (sin npm test)" '[ "$(marcas)" = "lint typecheck" ] && grep -q "Validaciones: estándar" <<< "$out" && ! grep -q "se reutiliza la aprobación" <<< "$out"'
  check "(3) ...y sigue al build local (falla a propósito en el repo falso) sin tocar el VPS" '[ $rc = 1 ] && grep -q "el build falló" <<< "$out" && only_status_ssh'
  check "(3) la estándar recién demostrada queda aprobada, nunca la completa" 'eh estandar && ! eh completa'
  out="$(e2e)"
  check "deploy normal siguiente reutiliza la estándar y dice que npm test NO se ejecutó" '[ -z "$(marcas)" ] && grep -q "se reutiliza la aprobación estándar: ESLint + TypeScript (npm test NO ejecutado)" <<< "$out"'
  echo "$RSHA" > "$E/active_sha"
  out="$(FAIL_TEST=1 e2e --validacion-completa)"; rc=$?
  check "completa con npm test fallido => se detiene; queda sólo la estándar (lint y typecheck pasaron)" '[ $rc = 1 ] && grep -q "fallaron tests" <<< "$out" && eh estandar && ! eh completa'
  e2e --validacion-completa >/dev/null
  E2E_SLEEP_TEST=30000 PATH="$ST:$PATH" HOME="$E/home" USERPROFILE="$(cygpath -w "$E/perfil")" BEYONIX_DEPLOY_REPO="$R" \
    bash "$HERE/deploy.sh" --validacion-completa > "$E/int.out" 2>&1 & DP=$!
  : > "$E/marcas"
  for _ in $(seq 1 120); do grep -qx test "$E/marcas" 2>/dev/null && break; sleep 0.5; done
  kill -TERM "$DP" 2>/dev/null; wait "$DP"; rc=$?
  check "(7) interrupción durante npm test => ninguna aprobación reutilizable (ni la estándar previa)" '[ $rc != 0 ] && grep -qx test "$E/marcas" && ! eh estandar && ! eh completa'
  # El node del test falso queda huérfano al cortar bash: se termina SÓLO ese proceso (línea "v.js test").
  cat > "$E/kill-orphan.ps1" <<'PS'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*v.js test*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
PS
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$E/kill-orphan.ps1")" >/dev/null 2>&1
  rmdir "$E/perfil/Documents/BEYONIX-backups/deploy-logs/.deploy.lock" 2>/dev/null
  out="$(e2e)"
  check "(7) tras la interrupción, deploy normal con commit activo termina sin desplegar" 'grep -q "ya tiene esta versión" <<< "$out" && no_build'

  # (8) Las protecciones previas siguen aplicándose también con -ValidacionCompleta, antes de validar.
  echo x >> "$R/v.js"
  out="$(e2e --validacion-completa)"; rc=$?
  check "(8) cambios sin commit => se detiene antes de validar" '[ $rc = 1 ] && grep -q "hay cambios sin commit" <<< "$out" && [ -z "$(marcas)" ]'
  git -C "$R" checkout -q -- v.js
  printf 'pm2_status=stopped\n' > "$E/status.extra"
  out="$(e2e --validacion-completa)"; rc=$?
  check "(8) PM2 no online => se detiene antes de validar" '[ $rc = 1 ] && grep -q "no está online" <<< "$out" && [ -z "$(marcas)" ]'
  rm -f "$E/status.extra"
  echo '[]' > "$E/migraciones.json"
  out="$(e2e --validacion-completa)"; rc=$?
  check "(8) respuesta de migraciones inválida => se detiene antes de validar" '[ $rc = 1 ] && grep -q "migraciones con formato inesperado" <<< "$out" && [ -z "$(marcas)" ]'
  echo '[{"version":"20260101000000"},{"version":"20990101000000"}]' > "$E/migraciones.json"
  out="$(e2e --validacion-completa)"; rc=$?
  check "(8) producción con migraciones desconocidas => se detiene antes de validar" '[ $rc = 1 ] && grep -q "migraciones que este commit no conoce" <<< "$out" && [ -z "$(marcas)" ]'
  echo '[{"version":"20260101000000"}]' > "$E/migraciones.json"
  echo 0000000000000000 > "$E/public_hash"
  out="$(e2e --validacion-completa)"; rc=$?
  check "(8) variables públicas distintas de producción => se detiene antes de validar" '[ $rc = 1 ] && grep -q "variables públicas" <<< "$out" && [ -z "$(marcas)" ]'
  check "(8) en ninguna ejecución hubo ssh/scp/curl/npx fuera de la lectura de estado y migraciones" '[ ! -s "$E/todo.log" ]'

  echo "19. deploy.sh aislado: espacio en el VPS y limpieza de releases"
  grep -E '^NEXT_PUBLIC_[A-Z0-9_]*=' "$R/.env.local" | tr -d '\r' | sed -E 's/[[:space:]]+$//' | LC_ALL=C sort | sha256sum | cut -c1-16 > "$E/public_hash"
  cleanups() { grep -c '^cleanup ' "$E/ssh.log"; }
  echo 0000000000000000000000000000000000000000 > "$E/active_sha"
  reset_space() { rm -f "$E/disk_free" "$E/cleanup_frees" "$E/cleanup_result" "$E/cleanup_rc"; }
  reset_space; echo 3700 > "$E/disk_free"; echo 9000 > "$E/cleanup_frees"
  out="$(FAIL_LINT=1 e2e --solo-preparar --validacion-completa)"; rc=$?
  check "poco espacio => limpia (ejecutar, mínimo 4000) antes de compilar y sigue" 'grep -qx "cleanup bash -s -- [0-9a-f-]* ejecutar 4000" "$E/ssh.log" && grep -q "Espacio liberado: 2 directorios eliminados, 2200 MB liberados" <<< "$out" && [ "$(marcas)" = lint ]'
  check "vuelve a leer el estado después de limpiar" '[ "$(grep -c "^status$" "$E/ssh.log")" = 2 ]'
  reset_space; echo 3700 > "$E/disk_free"; echo 3900 > "$E/cleanup_frees"; echo insuficiente > "$E/cleanup_result"; echo 7 > "$E/cleanup_rc"
  out="$(e2e --solo-preparar)"; rc=$?
  check "la limpieza no alcanza => se detiene con mensaje claro, sin validar ni compilar" '[ $rc = 1 ] && grep -q "menos de 4 GB libres en el VPS (3900 MB) y la limpieza automática no pudo liberar más de forma segura" <<< "$out" && grep -q "Limpiar -Simular" <<< "$out" && [ -z "$(marcas)" ] && no_build'
  reset_space; echo 3700 > "$E/disk_free"; echo 6 > "$E/cleanup_rc"; echo ocupado > "$E/cleanup_result"
  out="$(e2e)"; rc=$?
  check "limpieza ocupada (otro cambio en curso) => se detiene sin validar e informa el motivo" '[ $rc = 1 ] && grep -q "menos de 4 GB libres.*(hay un cambio de versión en curso; no se borra nada)" <<< "$out" && [ -z "$(marcas)" ]'
  reset_space; echo 9000 > "$E/disk_free"
  out="$(FAIL_LINT=1 e2e --solo-preparar --validacion-completa)"
  check "espacio suficiente => no limpia" '[ "$(cleanups)" = 0 ]'
  reset_space; echo 1000 > "$E/disk_free"; echo "$RSHA" > "$E/active_sha"
  out="$(e2e)"; rc=$?
  check "commit ya activo (nada que desplegar) => no limpia aunque haya poco espacio" '[ $rc = 0 ] && [ "$(cleanups)" = 0 ] && grep -q "ya tiene esta versión" <<< "$out"'
  echo 0000000000000000000000000000000000000000 > "$E/active_sha"
  reset_space
  out="$(e2e --limpiar --simular)"; rc=$?
  check "-Limpiar -Simular => sólo la simulación remota, sin validar ni compilar" '[ $rc = 0 ] && grep -qx "cleanup bash -s -- [0-9a-f-]* simular 0" "$E/ssh.log" && [ "$(wc -l < "$E/ssh.log")" = 1 ] && grep -q "Simulación: se liberarían 2200 MB" <<< "$out" && [ -z "$(marcas)" ]'
  out="$(e2e --limpiar)"; rc=$?
  check "-Limpiar => ejecuta y resume lo eliminado" '[ $rc = 0 ] && grep -qx "cleanup bash -s -- [0-9a-f-]* ejecutar 0" "$E/ssh.log" && grep -q "Limpieza completada: 2 directorios eliminados, 2200 MB liberados" <<< "$out"'
  echo 8 > "$E/cleanup_rc"; echo parcial > "$E/cleanup_result"
  out="$(e2e --limpiar)"; rc=$?
  check "-Limpiar con fallo parcial => error claro (rc 1)" '[ $rc = 1 ] && grep -q "no se pudieron borrar" <<< "$out"'
  reset_space
  for bad in "--limpiar --validacion-completa" "--limpiar --forzar" "--validacion-completa --limpiar"; do
    out="$(e2e $bad)"; rc=$?
    check "argumentos inválidos ($bad) => uso, sin conectar" '[ $rc = 2 ] && [ ! -s "$E/ssh.log" ]'
  done
  reset_space; echo rollback_invalido > "$E/cleanup_result"
  for args in "--limpiar --simular" "--limpiar"; do
    out="$(e2e $args)"; rc=$?
    check "$args con rollback registrado ausente/inválido => error con el motivo, rc 1, sin informar limpieza" \
      '[ $rc = 1 ] && grep -q "Error: la limpieza no se completó: la release de rollback registrada .* no existe o no es válida" <<< "$out" && ! grep -q "Simulación:\|Limpieza completada\|Resultado:" <<< "$out" && [ "$(wc -l < "$E/ssh.log")" = 1 ]'
  done
  echo 3700 > "$E/disk_free"
  out="$(e2e --solo-preparar)"; rc=$?
  check "deploy con poco espacio y rollback inválido => se detiene antes de compilar con el motivo" \
    '[ $rc = 1 ] && grep -q "menos de 4 GB libres.*rollback registrada.*no se borra nada" <<< "$out" && [ -z "$(marcas)" ] && no_build'
  reset_space
  check "ninguna prueba de limpieza hizo scp/curl/npx no permitidos" '[ ! -s "$E/todo.log" ]'
fi
echo
echo "RESULTADO LOCAL: $PASS OK, $FAIL fallos"
[ "$FAIL" = 0 ]
