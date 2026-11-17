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

echo
echo "RESULTADO LOCAL: $PASS OK, $FAIL fallos"
[ "$FAIL" = 0 ]
