#!/usr/bin/env bash
# Pruebas adversariales de los scripts del VPS en un sandbox AISLADO (/tmp/beyonix-deploy-sandbox.*):
# pm2 y curl falsos (rutas absolutas del sandbox), releases falsas, ningún contacto con la tienda.
# Se ejecuta EN EL VPS (Linux con flock y systemd --user):
#   tar -C deploy/release -c . | ssh ... 'd=$(mktemp -d) && tar -x -C "$d" && bash "$d/tests/run-vps-sandbox-tests.sh" "$d"; rm -rf -- "${d:?}"'
set -uo pipefail

SRC="${1:?uso: run-vps-sandbox-tests.sh <dir-con-los-scripts>}"
SB="$(mktemp -d /tmp/beyonix-deploy-sandbox.XXXXXX)"
export BEYONIX_DEPLOY_SANDBOX=1 BEYONIX_SANDBOX_ROOT="$SB"
APPS="$SB/apps"; RR="$APPS/beyonix-releases"; CUR="$APPS/beyonix-current"; ST="$SB/state"
PASS=0; FAIL=0
REAL_TARGET_BEFORE="$(readlink -f /home/beyonix/apps/beyonix-current 2>/dev/null || echo none)"
REAL_RESTARTS_BEFORE="$(pm2 jlist 2>/dev/null | node -e 'try{const p=JSON.parse(require("fs").readFileSync(0)).find(x=>x.name==="beyonix");console.log(p?p.pm2_env.restart_time:"-")}catch{console.log("-")}')"
cleanup() { case "$SB" in /tmp/beyonix-deploy-sandbox.*) rm -rf -- "$SB" ;; esac; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); echo "  ✔ $*"; }
ko() { FAIL=$((FAIL + 1)); echo "  ✘ $*"; }
check() {
  if eval "$2"; then ok "$1"; else
    ko "$1  [condición: $2]"
    printf '%s\n' "${out:-}" | tail -n 6 | sed 's/^/      | /'
  fi
}

# ── Fixtures ───────────────────────────────────────────────────────────────────
mkdir -p "$APPS/beyonix" "$RR" "$SB/bin" "$SB/pm2" "$SB/rollback" "$ST"
printf 'NEXT_PUBLIC_SITE_URL=https://sandbox.invalid\n' > "$APPS/beyonix/.env.local"
: > "$SB/pm2/beyonix-error.log"; echo '[]' > "$SB/pm2/dump.pm2"

make_release() { # make_release <nombre> <build>
  local r="$RR/$1"
  mkdir -p "$r/.next/static" "$r/node_modules/next" "$r/node_modules/sharp"
  echo '{"name":"next","version":"0.0.0"}' > "$r/node_modules/next/package.json"
  echo 'module.exports = {}' > "$r/node_modules/sharp/index.js"
  echo '{"name":"sharp","main":"index.js"}' > "$r/node_modules/sharp/package.json"
  printf '%s' "$2" > "$r/.next/BUILD_ID"
  echo "console.log('$2')" > "$r/.next/static/app.js"
  git -C "$r" init -q && git -C "$r" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$1"
  ln -s "$APPS/beyonix/.env.local" "$r/.env.local"
  (cd "$r" && find .next -type f -print0 | sort -z | xargs -0 sha256sum) > "$r/.next-files.sha256"
  printf 'sha=%s\nbuild_id=%s\n' "$(git -C "$r" rev-parse HEAD)" "$2" > "$r/.release-info"
}
R1=1111111-20260101-000001; R2=2222222-20260101-000002; R3=3333333-20260101-000003
make_release "$R1" BUILD-R1; make_release "$R2" BUILD-R2; make_release "$R3" BUILD-R3
ln -s "$RR/$R1" "$CUR"

# pm2 falso: estado en $ST; fallos inyectables con archivos en $ST/flags.
cat > "$SB/bin/pm2" <<'PM2'
#!/usr/bin/env bash
ST="$BEYONIX_SANDBOX_ROOT/state"; F="$ST/flags"; mkdir -p "$F"
CUR="$BEYONIX_SANDBOX_ROOT/apps/beyonix-current"
echo "$*" >> "$ST/pm2-calls"
consume() { [ -f "$F/$1" ] || return 1; local n; n="$(cat "$F/$1")"; [ "$n" = always ] && return 0; [ "$n" -gt 0 ] || return 1; echo $((n - 1)) > "$F/$1"; }
case "$1" in
  jlist)
    [ -f "$ST/absent" ] && { echo '[]'; exit 0; }
    [ -f "$F/jlist_error" ] && exit 1
    printf '[{"name":"beyonix","pm2_env":{"status":"%s","restart_time":%s,"pm_cwd":"%s"}}]\n' \
      "$(cat "$ST/status" 2>/dev/null || echo online)" "$(cat "$ST/restarts" 2>/dev/null || echo 0)" "$CUR" ;;
  restart)
    [ -f "$ST/absent" ] && exit 1
    if consume fail_restart; then
      [ -f "$F/lose_process_on_fail" ] && touch "$ST/absent" || echo errored > "$ST/status"
      exit 1
    fi
    readlink -f "$CUR" > "$ST/running"; echo online > "$ST/status"
    echo $(( $(cat "$ST/restarts" 2>/dev/null || echo 0) + 1 )) > "$ST/restarts"
    if consume crash_after_restart; then
      ( sleep 0.5; echo $(( $(cat "$ST/restarts") + 1 )) > "$ST/restarts" ) &
    fi ;;
  start)
    consume fail_start && exit 1
    rm -f "$ST/absent"; readlink -f "$CUR" > "$ST/running"; echo online > "$ST/status"; echo 0 > "$ST/restarts" ;;
  save) consume fail_save && exit 1; touch "$ST/saved" ;;
  *) exit 2 ;;
esac
PM2
# curl falso: sirve el BUILD_ID de la release "corriendo" salvo que esté marcada como enferma.
cat > "$SB/bin/curl" <<'CURL'
#!/usr/bin/env bash
ST="$BEYONIX_SANDBOX_ROOT/state"; out=""; fmt=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -w) fmt="$2"; shift 2 ;; --max-time) shift 2 ;; -s) shift ;; *) url="$1"; shift ;; esac; done
run="$(cat "$ST/running" 2>/dev/null)"
healthy=1
[ -n "$run" ] && [ "$(cat "$ST/status" 2>/dev/null || echo online)" = online ] && [ ! -f "$ST/absent" ] && [ ! -f "$run/.sandbox-unhealthy" ] || healthy=0
body="<html>$(cat "$run/.next/BUILD_ID" 2>/dev/null)</html>"
case "$url" in
  http://sandbox.invalid/) [ -f "$ST/flags/public_stale" ] && body="<html>OLD</html>"; [ "$healthy" = 1 ] && printf '%s' "$body"; exit 0 ;;
  http://sandbox.invalid:3000/*)
    if [ "$healthy" = 1 ]; then [ -n "$out" ] && printf '%s' "$body" > "$out"; code=200; else code=503; fi
    [ -n "$fmt" ] && printf '%s' "$code"; exit 0 ;;
  *) echo "curl falso: URL inesperada $url" >&2; exit 7 ;;
esac
CURL
chmod +x "$SB/bin/pm2" "$SB/bin/curl"

reset_state() { # deja r1 activa, online, sin fallos inyectados
  rm -rf "$ST"; mkdir -p "$ST/flags"
  ln -sfn "$RR/$R1" "$CUR"
  echo "$RR/$R1" > "$ST/running"; echo online > "$ST/status"; echo 0 > "$ST/restarts"
  rm -f "$RR/.deploy-history" "$RR/.last-switch" "$RR"/*/.sandbox-unhealthy
}
ID1=20260101-000000-aaaaaaa1; ID2=20260101-000000-aaaaaaa2; ID3=20260101-000000-aaaaaaa3
sw() { cat "$SRC/remote-lib.sh" "$SRC/remote-switch.sh" | bash -s -- "$@" 2>&1; }
rb() { cat "$SRC/remote-lib.sh" "$SRC/remote-rollback.sh" | bash -s -- "$@" 2>&1; }
active() { readlink -f "$CUR"; }
running() { cat "$ST/running"; }
result() { sed -E 's/^id=[^ ]+ result=([^ ]+) .*/\1/' "$RR/.last-switch" 2>/dev/null; }
hist() { if [ -f "$RR/.deploy-history" ]; then wc -l < "$RR/.deploy-history"; else echo 0; fi; }

# ── 0. Guardas del sandbox ─────────────────────────────────────────────────────
echo "0. Guardas del sandbox"
resolved="$(printf 'echo "$PM2|$CURL|$APPS"\n' | cat "$SRC/remote-lib.sh" - | bash -s)"
check "pm2/curl/apps resuelven al sandbox" '[ "$resolved" = "$SB/bin/pm2|$SB/bin/curl|$APPS" ]'
out="$(BEYONIX_SANDBOX_ROOT=/home/beyonix/apps bash -c 'cat "$1/remote-lib.sh" "$1/remote-status.sh" | bash -s' _ "$SRC")"; rc=$?
check "sandbox fuera de /tmp => se niega (exit 9)" '[ $rc = 9 ]'

# ── 1. Activación normal ───────────────────────────────────────────────────────
echo "1. Activación normal"
reset_state; out="$(sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?
check "exit 0" '[ $rc = 0 ]'
check "enlace y proceso en R2" '[ "$(active)" = "$RR/$R2" ] && [ "$(running)" = "$RR/$R2" ]'
check "historial 1 línea y resultado ACTIVADA" '[ "$(hist)" = 1 ] && [ "$(result)" = ACTIVADA ]'
check "pm2 save ejecutado" '[ -f "$ST/saved" ]'

# ── 2. Fallo de pm2 restart ────────────────────────────────────────────────────
echo "2. Fallo de pm2 restart (una vez)"
reset_state; echo 1 > "$ST/flags/fail_restart"; out="$(sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?
check "exit 3 (recuperada)" '[ $rc = 3 ]'
check "enlace y proceso vuelven a R1" '[ "$(active)" = "$RR/$R1" ] && [ "$(running)" = "$RR/$R1" ]'
check "motivo informado: pm2 restart falló" 'grep -q "ROLLBACK: pm2 restart falló" <<< "$out"'
check "sin historial ni ACTIVADA" '[ "$(hist)" = 0 ] && ! grep -q "^ACTIVADA" <<< "$out" && [ "$(result)" = ROLLBACK_OK ]'

echo "2b. pm2 restart falla y PM2 pierde el proceso"
reset_state; echo 1 > "$ST/flags/fail_restart"; touch "$ST/flags/lose_process_on_fail"; out="$(sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?
check "exit 3: lo recrea con pm2 start y vuelve a R1" '[ $rc = 3 ] && [ "$(running)" = "$RR/$R1" ] && grep -q "^start npm --name beyonix" "$ST/pm2-calls"'

# ── 3. Fallo de pm2 save ───────────────────────────────────────────────────────
echo "3. Fallo de pm2 save"
reset_state; echo 1 > "$ST/flags/fail_save"; out="$(sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?
check "exit 5 (activa y sana, save diferenciado)" '[ $rc = 5 ] && [ "$(active)" = "$RR/$R2" ] && [ "$(result)" = ACTIVADA_SIN_SAVE ]'
check "aviso explícito de pm2 save" 'grep -q "pm2 save falló" <<< "$out"'

# ── 4. Versión nueva sin salud / inestable / pública vieja ─────────────────────
echo "4. Versión nueva enferma"
reset_state; touch "$RR/$R2/.sandbox-unhealthy"; out="$(sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?
check "sin salud => exit 3 y vuelve a R1" '[ $rc = 3 ] && [ "$(active)" = "$RR/$R1" ] && [ "$(running)" = "$RR/$R1" ]'
reset_state; echo 1 > "$ST/flags/crash_after_restart"; out="$(sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?
check "se reinicia solo tras activar => exit 3" '[ $rc = 3 ] && grep -q "se reinició solo" <<< "$out" && [ "$(active)" = "$RR/$R1" ]'
reset_state; touch "$ST/flags/public_stale"; out="$(sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?
check "sitio público viejo => exit 3" '[ $rc = 3 ] && grep -q "sitio público" <<< "$out"'
reset_state; echo "Error: Cannot find module 'x'" > "$SB/pm2/err.tmp"
( sleep 1.2; cat "$SB/pm2/err.tmp" >> "$SB/pm2/beyonix-error.log" ) &
out="$(BEYONIX_SANDBOX_STABILITY=2 sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?; wait
check "errores críticos en logs => exit 3" '[ $rc = 3 ] && grep -q "errores críticos" <<< "$out"'
: > "$SB/pm2/beyonix-error.log"

# ── 5. Rollback fallido (alerta crítica) ───────────────────────────────────────
echo "5. Recuperación imposible"
reset_state; echo always > "$ST/flags/fail_restart"; out="$(sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?
check "exit 4 con ALERTA CRÍTICA" '[ $rc = 4 ] && grep -q "ALERTA CRÍTICA" <<< "$out" && [ "$(result)" = CRITICO ]'
check "nunca informa éxito" '! grep -qE "^(ACTIVADA|ROLLBACK OK)" <<< "$out"'
check "el enlace queda en la versión previa" '[ "$(active)" = "$RR/$R1" ]'
reset_state; touch "$RR/$R2/.sandbox-unhealthy" "$RR/$R1/.sandbox-unhealthy"; out="$(sw "$RR/$R2" "$RR/$R1" "$ID1")"; rc=$?
check "ambas versiones enfermas => exit 4" '[ $rc = 4 ]'
reset_state; ln -sfn "$RR/$R2" "$CUR"; echo "$RR/$R2" > "$ST/running"
echo "x prev=$RR/$R1 new=$RR/$R2 build=BUILD-R2 id=$ID1" > "$RR/.deploy-history"
touch "$RR/$R1/.sandbox-unhealthy"; out="$(rb "$ID2" - -)"; rc=$?
check "rollback manual a destino enfermo => exit 3, se mantiene R2" '[ $rc = 3 ] && [ "$(active)" = "$RR/$R2" ] && [ "$(running)" = "$RR/$R2" ]'
reset_state; ln -sfn "$RR/$R2" "$CUR"; echo "$RR/$R2" > "$ST/running"; echo always > "$ST/flags/fail_restart"
out="$(rb "$ID2" - "$RR/$R1")"; rc=$?
check "rollback con PM2 roto => exit 4 ALERTA, sin éxito" '[ $rc = 4 ] && grep -q "ALERTA CRÍTICA" <<< "$out" && ! grep -q "^ROLLBACK OK" <<< "$out"'

# ── 6. Releases incompletas ────────────────────────────────────────────────────
echo "6. Releases incompletas o no verificadas"
bad() { # bad <nombre> <descripción> <comando-de-daño>
  local name="$1" r="$RR/$1"
  make_release "$name" "BUILD-$name"; eval "$3"
  reset_state
  out="$(rb "$ID2" - "$r")"; local rc1=$?
  out2="$(sw "$r" "$RR/$R1" "$ID3")"; local rc2=$?
  check "$2 => rollback y activación rechazados sin tocar nada" '[ $rc1 = 1 ] && [ $rc2 = 1 ] && [ "$(active)" = "$RR/$R1" ] && ! grep -q restart "$ST/pm2-calls" 2>/dev/null'
}
bad 4444444-20260101-000004 "sin .release-info" 'rm "$r/.release-info"'
bad 5555555-20260101-000005 "BUILD_ID distinto de .release-info" 'printf OTRO > "$r/.next/BUILD_ID"'
bad 6666666-20260101-000006 "archivo del build alterado" 'echo hack >> "$r/.next/static/app.js"'
bad 7777777-20260101-000007 "sin dependencias (sharp)" 'rm -rf "$r/node_modules/sharp"'
bad 8888888-20260101-000008 "sin manifest de integridad" 'rm "$r/.next-files.sha256"'
bad 9999999-20260101-000009 "código distinto del commit registrado" 'sed -i "s/^sha=.*/sha=$(printf "%040d" 0)/" "$r/.release-info"'
reset_state; mkdir -p "$APPS/beyonix/.next"; echo ORIG > "$APPS/beyonix/.next/BUILD_ID"
out="$(rb "$ID2" - "$APPS/beyonix")"; rc=$?
check "versión original ~/apps/beyonix rechazada (usa su mecanismo propio)" '[ $rc = 1 ] && [ "$(active)" = "$RR/$R1" ]'
reset_state; out="$(rb "$ID2" - "$RR/../beyonix")"; rc=$?
check "ruta que sale de releases (..) rechazada" '[ $rc = 1 ] && [ "$(active)" = "$RR/$R1" ]'

echo "6b. Release anterior al sistema (manifest en su incoming)"
L=aaaaaaa-20260101-000010; make_release "$L" BUILD-LEGACY
mkdir -p "$RR/incoming-20260101-000010"; mv "$RR/$L/.next-files.sha256" "$RR/incoming-20260101-000010/next-files.sha256"
printf 'sha=x\nbuild_id=BUILD-LEGACY\n' > "$RR/incoming-20260101-000010/meta.env"
reset_state; out="$(rb "$ID2" - "$RR/$L")"; rc=$?
check "validada con el manifest de su incoming => exit 0" '[ $rc = 0 ] && [ "$(active)" = "$RR/$L" ]'
echo hack >> "$RR/$L/.next/static/app.js"; reset_state; out="$(rb "$ID2" - "$RR/$L")"; rc=$?
check "y alterada => rechazada" '[ $rc = 1 ]'

# ── 7. Despliegues concurrentes ────────────────────────────────────────────────
echo "7. Concurrencia"
reset_state
( BEYONIX_SANDBOX_STABILITY=3 sw "$RR/$R2" "$RR/$R1" "$ID1" > "$SB/a.out"; echo $? > "$SB/a.rc" ) &
sleep 1
out="$(sw "$RR/$R3" "$RR/$R1" "$ID2")"; rc=$?
check "segundo cambio mientras corre el primero => rechazado" '[ $rc = 1 ] && grep -q "otro cambio de versión" <<< "$out"'
out="$(rb "$ID3" - "$RR/$R3")"; rc=$?
check "rollback mientras corre un cambio => rechazado" '[ $rc = 1 ] && grep -q "otro cambio de versión" <<< "$out"'
wait
check "el primero terminó bien" '[ "$(cat "$SB/a.rc")" = 0 ] && [ "$(active)" = "$RR/$R2" ]'
out="$(sw "$RR/$R3" "$RR/$R1" "$ID2")"; rc=$?
check "activación con versión activa desactualizada => rechazada" '[ $rc = 1 ] && grep -q "la versión activa cambió" <<< "$out" && [ "$(active)" = "$RR/$R2" ]'
out="$(rb "$ID3" "$RR/$R3" "$RR/$R1")"; rc=$?
check "rollback tardío sobre otra versión => rechazado" '[ $rc = 1 ] && grep -q "ya no es la esperada" <<< "$out" && [ "$(active)" = "$RR/$R2" ]'
check "historial consistente (1 activación)" '[ "$(hist)" = 1 ]'
out="$(rb "$ID3" - -)"; rc=$?
check "rollback por historial vuelve a R1 y registra" '[ $rc = 0 ] && [ "$(active)" = "$RR/$R1" ] && [ "$(hist)" = 2 ]'

# ── 8. Interrupción de red ─────────────────────────────────────────────────────
echo "8. Interrupción de red"
reset_state
( cat "$SRC/remote-lib.sh" "$SRC/remote-switch.sh" | BEYONIX_SANDBOX_STABILITY=2 bash -s -- "$RR/$R2" "$RR/$R1" "$ID1" 2>&1 ) | head -c 1 > /dev/null
sleep 6
check "salida cortada a mitad: el VPS termina solo y deja el resultado" '[ "$(result)" = ACTIVADA ] && [ "$(active)" = "$RR/$R2" ]'
reset_state
full="$(cat "$SRC/remote-lib.sh" "$SRC/remote-switch.sh")"
printf '%s' "${full:0:$(( ${#full} - 400 ))}" | bash -s -- "$RR/$R2" "$RR/$R1" "$ID1" > /dev/null 2>&1; rc=$?
check "script truncado en el envío => no ejecuta nada" '[ $rc != 0 ] && [ "$(active)" = "$RR/$R1" ] && [ ! -s "$ST/pm2-calls" ]'
status_out="$(cat "$SRC/remote-lib.sh" "$SRC/remote-status.sh" | bash -s -- "$ID1")"
check "remote-status informa resultado por deploy-id y bloqueo libre" 'grep -q "^switch_lock=libre" <<< "$status_out" && grep -q "^switch_result=" <<< "$status_out"'

# ── 9. Argumentos manipulados (lado VPS) ───────────────────────────────────────
echo "9. Argumentos manipulados"
reset_state
out="$(sw "$RR/$R2" "$RR/$R1" 'x;touch /tmp/pwned')"; rc=$?
check "deploy-id con ; => rechazado" '[ $rc = 1 ] && [ ! -e /tmp/pwned ] && [ "$(active)" = "$RR/$R1" ]'
out="$(sw '$(touch /tmp/pwned2)' "$RR/$R1" "$ID1")"; rc=$?
check "release con \$( ) => rechazada sin ejecutarse" '[ $rc = 1 ] && [ ! -e /tmp/pwned2 ]'
out="$(cat "$SRC/remote-lib.sh" "$SRC/remote-assemble.sh" | bash -s -- "$(printf 'a%.0s' {1..40})" /tmp 2>&1)"; rc=$?
check "assemble con SHA/incoming inválidos => rechazado" '[ $rc = 1 ]'
out="$(cat "$SRC/remote-lib.sh" "$SRC/remote-assemble.sh" | bash -s -- "$(printf '%040d' 0)" "$RR/../beyonix-releases/incoming-x" 2>&1)"; rc=$?
check "assemble con incoming fuera de patrón => rechazado" '[ $rc = 1 ]'

# ── 10. Memoria durante npm ci ─────────────────────────────────────────────────
echo "10. Memoria durante npm ci"
cat > "$SB/bin/npm" <<'NPM'
#!/usr/bin/env bash
exec node -e 'const a=[]; for (let i=0;i<Number(process.env.ALLOC_MB||0);i++) a.push(Buffer.alloc(1048576, 1)); console.log("ok")'
NPM
chmod +x "$SB/bin/npm"
limited() { (sed '$d' "$SRC/remote-assemble.sh" | cat "$SRC/remote-lib.sh" - ; echo 'limited_npm_ci "$1"') | bash -s -- "$SB" 2>&1; }
out="$(ALLOC_MB=400 BEYONIX_SANDBOX_NPM_MEMORY=150M BEYONIX_SANDBOX_NPM_MIN_MB=100 limited)"; rc=$?
check "npm ci que supera MemoryMax => falla (OOM en su scope)" '[ $rc != 0 ]'
check "PM2 real intacto tras el OOM del sandbox" '[ "$(pm2 jlist | node -e "const p=JSON.parse(require(\"fs\").readFileSync(0)).find(x=>x.name===\"beyonix\");console.log(p.pm2_env.status)")" = online ]'
out="$(ALLOC_MB=20 BEYONIX_SANDBOX_NPM_MEMORY=150M BEYONIX_SANDBOX_NPM_MIN_MB=100 limited)"; rc=$?
check "npm ci dentro del límite => OK" '[ $rc = 0 ]'
out="$(ALLOC_MB=1 BEYONIX_SANDBOX_NPM_MIN_MB=999999 limited)"; rc=$?
check "memoria disponible insuficiente => no arranca npm ci" '[ $rc != 0 ] && grep -q "memoria disponible" <<< "$out"'

# ── Producción intacta ─────────────────────────────────────────────────────────
echo "11. Producción real intacta"
check "enlace real sin cambios" '[ "$(readlink -f /home/beyonix/apps/beyonix-current)" = "$REAL_TARGET_BEFORE" ]'
REAL_RESTARTS_AFTER="$(pm2 jlist 2>/dev/null | node -e 'try{const p=JSON.parse(require("fs").readFileSync(0)).find(x=>x.name==="beyonix");console.log(p?p.pm2_env.restart_time:"-")}catch{console.log("-")}')"
check "PM2 real sin reinicios" '[ "$REAL_RESTARTS_AFTER" = "$REAL_RESTARTS_BEFORE" ]'
check "historial real sin entradas de prueba" '! grep -qs "aaaaaaa" /home/beyonix/apps/beyonix-releases/.deploy-history'

echo
echo "RESULTADO VPS: $PASS OK, $FAIL fallos"
[ "$FAIL" = 0 ]
