#!/usr/bin/env bash
# Pruebas de la limpieza de releases (remote-cleanup.sh) en un sandbox AISLADO
# (/tmp/beyonix-deploy-sandbox.*): releases, PM2, df, flock, rm y mv falsos. No usa red ni SSH.
# Corre en la PC (Git Bash; los enlaces se crean como accesos directos de MSYS) y también en Linux.
# Sin `flock` real (Git Bash) los bloqueos se simulan con marcas "<archivo>.held"; en Linux con
# flock real se toman de verdad desde otro proceso.
# Uso: bash deploy/release/tests/run-cleanup-tests.sh
set -uo pipefail
export MSYS="${MSYS:+$MSYS }winsymlinks:lnk"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="$(mktemp -d /tmp/beyonix-deploy-sandbox.XXXXXX)"
case "$SB" in /tmp/beyonix-deploy-sandbox.*) ;; *) echo "sandbox inesperado: $SB"; exit 1 ;; esac
export BEYONIX_DEPLOY_SANDBOX=1 BEYONIX_SANDBOX_ROOT="$SB"
APPS="$SB/apps"; RR="$APPS/beyonix-releases"; CUR="$APPS/beyonix-current"; ST="$SB/state"
PASS=0; FAIL=0
HOLDERS=()
cleanup() {
  local p
  for p in "${HOLDERS[@]}"; do kill "$p" 2>/dev/null; done
  case "$SB" in /tmp/beyonix-deploy-sandbox.*) rm -rf -- "$SB" ;; esac
}
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); echo "  ✔ $*"; }
ko() { FAIL=$((FAIL + 1)); echo "  ✘ $*"; }
check() {
  if eval "$2"; then ok "$1"; else
    ko "$1  [condición: $2]"
    printf '%s\n' "${out:-}" | tail -n 8 | sed 's/^/      | /'
  fi
}

mkdir -p "$SB/bin" "$ST"
# ── Herramientas falsas ─────────────────────────────────────────────────────────
cat > "$SB/bin/pm2" <<'PM2'
#!/usr/bin/env bash
ST="$BEYONIX_SANDBOX_ROOT/state"
[ "$1" = jlist ] || exit 2
[ -f "$ST/pm2_error" ] && exit 1
[ -f "$ST/pm2_absent" ] && { echo '[]'; exit 0; }
cwd="$(cat "$ST/pm2_cwd" 2>/dev/null || echo "$BEYONIX_SANDBOX_ROOT/apps/beyonix-current")"
printf '[{"name":"beyonix","pm2_env":{"status":"online","restart_time":0,"pm_cwd":"%s"}}]\n' "$cwd"
PM2
cat > "$SB/bin/df" <<'DF'
#!/usr/bin/env bash
printf 'Avail\n%s\n' "$(cat "$BEYONIX_SANDBOX_ROOT/state/free_mb" 2>/dev/null || echo 9000)"
DF
# rm/mv falsos: fallan para los nombres listados en state/fail_rm|fail_mv; mv puede además mover el
# enlace activo (state/switch_on_mv) para simular un cambio de versión en plena limpieza.
cat > "$SB/bin/fake-rm" <<'RM'
#!/usr/bin/env bash
ST="$BEYONIX_SANDBOX_ROOT/state"
for a in "$@"; do
  [ -f "$ST/fail_rm" ] && grep -qF -- "$(cat "$ST/fail_rm")" <<< "$a" && { /usr/bin/rm -rf -- "$a/.next" 2>/dev/null; exit 1; }
done
exec /usr/bin/rm "$@"
RM
cat > "$SB/bin/fake-mv" <<'MV'
#!/usr/bin/env bash
ST="$BEYONIX_SANDBOX_ROOT/state"
for a in "$@"; do
  [ -f "$ST/fail_mv" ] && grep -qF -- "$(cat "$ST/fail_mv")" <<< "$a" && exit 1
done
if [ -f "$ST/switch_on_mv" ]; then
  /usr/bin/ln -sfn "$(cat "$ST/switch_on_mv")" "$BEYONIX_SANDBOX_ROOT/apps/beyonix-current"; /usr/bin/rm -f "$ST/switch_on_mv"
fi
exec /usr/bin/mv "$@"
MV
chmod +x "$SB/bin/"*
export BEYONIX_SANDBOX_DF="$SB/bin/df" BEYONIX_SANDBOX_RM="$SB/bin/fake-rm" BEYONIX_SANDBOX_MV="$SB/bin/fake-mv"
REAL_FLOCK=0
if command -v flock >/dev/null 2>&1; then
  REAL_FLOCK=1
else
  cat > "$SB/bin/flock" <<'FLOCK'
#!/usr/bin/env bash
# flock falso: "tomado por otro proceso" = existe <archivo>.held
while [ $# -gt 0 ]; do case "$1" in -n|-s|-x) shift ;; *) break ;; esac; done
t="$1"; shift
if [[ "$t" =~ ^[0-9]+$ ]]; then f="$(readlink "/proc/self/fd/$t")"; else f="$t"; fi
[ -e "$f.held" ] && exit 1
[ $# -gt 0 ] && exec "$@"
exit 0
FLOCK
  chmod +x "$SB/bin/flock"
  export BEYONIX_SANDBOX_FLOCK="$SB/bin/flock"
fi
hold_lock() { # hold_lock <archivo> [-s]: otro proceso toma el bloqueo
  if [ "$REAL_FLOCK" = 1 ]; then
    ( exec 7>"$1"; flock ${2:-} 7; touch "$1.ready"; sleep 300 ) & HOLDERS+=($!)
    for _ in $(seq 1 50); do [ -e "$1.ready" ] && break; sleep 0.1; done
  else
    touch "$1.held"
  fi
}
release_locks() {
  local p
  for p in "${HOLDERS[@]}"; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
  HOLDERS=()
  rm -f "$RR"/.*.lock.held "$RR"/.*.lock.ready
}

# ── Fixtures ───────────────────────────────────────────────────────────────────
make_release() { # make_release <nombre> <build> [prepared_at|-] (- = sin .release-info)
  local r="$RR/$1"
  mkdir -p "$r/.next/static" "$r/node_modules/next" "$r/node_modules/sharp"
  echo '{"name":"next","version":"0.0.0"}' > "$r/node_modules/next/package.json"
  echo 'module.exports = {}' > "$r/node_modules/sharp/index.js"
  echo '{"name":"sharp","main":"index.js"}' > "$r/node_modules/sharp/package.json"
  printf '%s' "$2" > "$r/.next/BUILD_ID"
  echo "console.log('$2')" > "$r/.next/static/app.js"
  # Mismo prefijo => mismo commit (mismo SHA), como dos releases preparadas del mismo commit.
  git -C "$r" init -q && GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' \
    git -C "$r" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "${1%%-*}"
  ln -s "$APPS/beyonix/.env.local" "$r/.env.local"
  (cd "$r" && find .next -type f -print0 | sort -z | xargs -0 sha256sum) > "$r/.next-files.sha256"
  if [ "${3:--}" != - ]; then
    printf 'sha=%s\nbuild_id=%s\nprepared_at=%s\n' "$(git -C "$r" rev-parse HEAD)" "$2" "$3" > "$r/.release-info"
  fi
}
make_incoming() { # make_incoming <nombre> <build> <antigüedad: viejo|nuevo>
  mkdir -p "$RR/$1"; printf 'sha=x\nbuild_id=%s\n' "$2" > "$RR/$1/meta.env"; echo x > "$RR/$1/next-build.tar.gz"
  [ "$3" = viejo ] && touch -d '2026-11-16 12:00' "$RR/$1"
  return 0
}
# Mismo escenario que producción el 2026-11-24 (nombres reales; contenido falso).
ACT=be85649-20261123-233201; RB=919a98b-20261123-194830; PEND=5e00e49-20261124-131637
PEND_OLD=5e00e49-20261124-101500; EXTRA=e378b97-20261118-140153; DUP=919a98b-20261123-182403
OLD1=a24e34d-20261117-142753; OLD2=919a98b-20261123-193650; FAILED=ac1fe04-20261116-115341; INPROG=fffffff-20261124-140000
seed() {
  rm -rf "$APPS" "$ST"; mkdir -p "$APPS/beyonix" "$RR/.deploy-logs" "$ST"
  printf 'NEXT_PUBLIC_SITE_URL=https://sandbox.invalid\nSECRETO=no-tocar\n' > "$APPS/beyonix/.env.local"
  echo original > "$APPS/beyonix/marca"
  make_release "$OLD1" B-OLD1 2026-11-17T14:29:20-03:00
  make_release "$OLD2" B-OLD2 2026-11-23T19:38:22-03:00
  make_release "$DUP" B-DUP 2026-11-23T18:25:41-03:00
  make_release "$EXTRA" B-EXTRA 2026-11-18T14:02:31-03:00
  make_release "$RB" B-RB 2026-11-23T19:49:51-03:00
  make_release "$ACT" B-ACT 2026-11-23T23:33:33-03:00
  make_release "$PEND_OLD" B-PEND-OLD 2026-11-24T10:16:00-03:00
  make_release "$PEND" B-PEND 2026-11-24T13:18:05-03:00
  make_release "$FAILED" B-FAILED -; touch -d '2026-11-16 12:00' "$RR/$FAILED"
  make_release "$INPROG" B-INPROG -                       # armándose ahora (sin .release-info, reciente)
  make_incoming incoming-20261117-142747 B-OLD1 viejo
  make_incoming incoming-20261123-233156 B-ACT viejo     # manifest de una release conservada
  make_incoming incoming-20261124-131631 B-PEND nuevo
  make_incoming incoming-20261124-140000 B-INPROG nuevo  # transferencia en curso
  mkdir -p "$RR/.trash-c098c94-20261118-113852-999/.next"  # resto de una limpieza interrumpida
  mkdir -p "$RR/notas-del-operador"                          # nombre fuera de los patrones
  ln -s "$APPS/beyonix" "$RR/1234567-20260101-000000"        # enlace con nombre de release
  ln -s "$RR/$ACT" "$CUR"
  {
    echo "2026-11-23T19:52:26-03:00 prev=$RR/$OLD2 new=$RR/$RB build=B-RB id=20261123-194321-1192a5d5"
    echo "2026-11-23T23:34:39-03:00 prev=$RR/$RB new=$RR/$ACT build=B-ACT id=20261123-232448-1f4ceaa2"
  } > "$RR/.deploy-history"
  echo "id=20261123-232448-1f4ceaa2 result=ACTIVADA" > "$RR/.last-switch"
  echo log > "$RR/.deploy-logs/x.log"
  echo 9000 > "$ST/free_mb"
}
ID=20261124-150000-abcdef01
clean() { cat "$SRC/remote-lib.sh" "$SRC/remote-cleanup.sh" | tr -d '\r' | bash -s -- "$@" 2>&1; }
# "ok" si la release pasa validate_release (la misma comprobación que exige -Rollback).
clean_validate() {
  { tr -d '\r' < "$SRC/remote-lib.sh"; echo 'validate_release "$1" >/dev/null && echo ok || echo "$INVALID_REASON"'; } \
    | bash -s -- "$RR/$1" 2>&1
}
exists() { [ -e "$RR/$1" ] || [ -L "$RR/$1" ]; }
all_exist() { local n; for n in "$@"; do exists "$n" || return 1; done; }
none_exist() { local n; for n in "$@"; do exists "$n" && return 1; done; return 0; }
PROTECTED=("$ACT" "$RB" "$PEND" "$EXTRA" "$INPROG" incoming-20261123-233156 incoming-20261124-131631 incoming-20261124-140000)
DELETABLE=("$OLD1" "$OLD2" "$DUP" "$PEND_OLD" "$FAILED" incoming-20261117-142747 .trash-c098c94-20261118-113852-999)
untouched_rest() { # lo que nunca se toca
  [ "$(readlink -f "$CUR")" = "$RR/$ACT" ] && [ "$(cat "$APPS/beyonix/marca")" = original ] \
    && grep -q SECRETO "$APPS/beyonix/.env.local" && [ -d "$RR/notas-del-operador" ] && [ -L "$RR/1234567-20260101-000000" ] \
    && [ "$(wc -l < "$RR/.deploy-history")" = 2 ] && [ -f "$RR/.last-switch" ] && [ -f "$RR/.deploy-logs/x.log" ]
}
nothing_deleted() { all_exist "${PROTECTED[@]}" "${DELETABLE[@]}" && untouched_rest; }

echo "1. Simulación"
seed
out="$(clean "$ID" simular 4000)"; rc=$?
check "simular => rc 0 y no borra nada" '[ $rc = 0 ] && nothing_deleted'
check "simular => lista exactamente lo prescindible" '[ "$(grep -c "^ELIMINAR " <<< "$out")" = ${#DELETABLE[@]} ] && for n in "${DELETABLE[@]}"; do grep -q "^ELIMINAR $n " <<< "$out" || exit 1; done'
check "simular => informa resultado=simulada" 'grep -q "^LIMPIEZA resultado=simulada " <<< "$out"'

echo "2. Política de retención (ejecutar)"
out="$(clean "$ID" ejecutar 4000)"; rc=$?
check "ejecutar => rc 0, resultado=ok" '[ $rc = 0 ] && grep -q "^LIMPIEZA resultado=ok eliminadas=${#DELETABLE[@]} " <<< "$out"'
check "protege la release ACTIVA" 'exists "$ACT" && grep -q "^CONSERVAR $ACT motivo=activa" <<< "$out"'
check "protege la release de ROLLBACK (prev= del historial)" 'exists "$RB" && grep -q "^CONSERVAR $RB motivo=rollback" <<< "$out"'
check "protege la PREPARADA pendiente (5e00e49)" 'exists "$PEND" && grep -q "^CONSERVAR $PEND motivo=preparada pendiente" <<< "$out"'
check "conserva un respaldo adicional verificado" 'exists "$EXTRA" && grep -q "^CONSERVAR $EXTRA motivo=respaldo adicional" <<< "$out"'
check "protege lo que se está armando (sin .release-info, reciente)" 'exists "$INPROG"'
check "protege incoming recientes y el de una release conservada" 'all_exist incoming-20261123-233156 incoming-20261124-131631 incoming-20261124-140000'
check "borra releases viejas, duplicadas, fallidas, incoming viejo y restos" 'none_exist "${DELETABLE[@]}"'
check "no deja directorios .trash-*" '[ -z "$(ls -A "$RR" | grep "^\.trash-")" ]'
check "nunca toca ~/apps/beyonix, .env.local, historial, logs, enlaces ni nombres ajenos" 'untouched_rest'
check "las releases conservadas siguen siendo válidas (rollback utilizable)" '[ "$(clean_validate "$RB")" = ok ] && [ "$(clean_validate "$PEND")" = ok ]'
check "registra cada eliminación y el espacio en .cleanup-history" '[ "$(grep -c " eliminada=" "$RR/.cleanup-history")" = ${#DELETABLE[@]} ] && grep -q "resultado=ok eliminadas=${#DELETABLE[@]} liberado_mb=" "$RR/.cleanup-history"'
check "deja log en .deploy-logs" '[ -s "$RR/.deploy-logs/$ID-cleanup.log" ]'
out="$(clean "$ID" ejecutar 4000)"; rc=$?
check "segunda ejecución => idempotente (0 eliminadas)" '[ $rc = 0 ] && grep -q "resultado=ok eliminadas=0 " <<< "$out" && all_exist "${PROTECTED[@]}"'

echo "3. Tras activar la preparada: la anterior pasa a rollback"
seed
echo "2026-11-24T15:00:00-03:00 prev=$RR/$ACT new=$RR/$PEND build=B-PEND id=20261124-145500-aaaaaaa1" >> "$RR/.deploy-history"
ln -sfn "$RR/$PEND" "$CUR"
out="$(clean "$ID" ejecutar 0)"; rc=$?
check "nueva activa + rollback a la anterior conservadas" '[ $rc = 0 ] && all_exist "$PEND" "$ACT" && grep -q "^CONSERVAR $ACT motivo=rollback" <<< "$out"'
check "la vieja rollback pasa a respaldo y el resto se elimina" 'exists "$RB" && none_exist "$EXTRA" "$DUP" "$OLD1" "$PEND_OLD"'

echo "4. Estado no confiable => no borra nada"
for case_ in pm2_error pm2_absent pm2_cwd sin_historial sin_enlace activa_fuera; do
  seed
  case "$case_" in
    pm2_error) touch "$ST/pm2_error" ;;
    pm2_absent) touch "$ST/pm2_absent" ;;
    pm2_cwd) echo "$APPS/beyonix" > "$ST/pm2_cwd" ;;
    sin_historial) rm -f "$RR/.deploy-history" ;;
    sin_enlace) rm -f "$CUR" ;;
    activa_fuera) rm -f "$CUR"; ln -s "$APPS/beyonix" "$CUR" ;;
  esac
  out="$(clean "$ID" ejecutar 4000)"; rc=$?
  check "$case_ => rc 1, nada borrado" '[ $rc = 1 ] && all_exist "${PROTECTED[@]}" "${DELETABLE[@]}"'
done

echo "4b. Rollback registrado ausente o inválido => no borra nada (simular y ejecutar)"
# Todo lo del escenario salvo el rollback (que en "ausente" ya no existe).
others_intact() { local n; for n in "${PROTECTED[@]}" "${DELETABLE[@]}"; do [ "$n" = "$RB" ] || exists "$n" || return 1; done; untouched_rest; }
for case_ in ausente sin_prev sin_release_info build_alterado archivos_alterados sin_dependencias enlace fuera_de_releases; do
  for mode in simular ejecutar; do
    seed
    case "$case_" in
      ausente) rm -rf -- "${RR:?}/$RB" ;;
      sin_prev) sed -i "s| prev=$RR/$RB||" "$RR/.deploy-history" ;;
      sin_release_info) rm -f "$RR/$RB/.release-info" ;;
      build_alterado) printf 'OTRO' > "$RR/$RB/.next/BUILD_ID" ;;
      archivos_alterados) echo alterado >> "$RR/$RB/.next/static/app.js" ;;
      sin_dependencias) rm -rf -- "${RR:?}/$RB/node_modules/sharp" ;;
      enlace) rm -rf -- "${RR:?}/$RB"; ln -s "$RR/$EXTRA" "$RR/$RB" ;;
      fuera_de_releases) sed -i "s| prev=$RR/$RB | prev=$APPS/beyonix |" "$RR/.deploy-history" ;;
    esac
    out="$(clean "$ID" "$mode" 4000)"; rc=$?
    check "rollback $case_ ($mode) => rc 1, sin ELIMINAR ni borrado" \
      '[ $rc = 1 ] && grep -q "^DETENER: .*rollback.*no se borra nada" <<< "$out" && ! grep -q "^ELIMINAR\|^eliminada\|^LIMPIEZA" <<< "$out" && others_intact && [ ! -e "$RR/.cleanup-history" ]'
  done
done

echo "5. Concurrencia"
seed; hold_lock "$RR/.switch.lock"
out="$(clean "$ID" ejecutar 4000)"; rc=$?
check "cambio de versión en curso (switch/rollback) => ocupado, nada borrado" '[ $rc = 6 ] && grep -q "^OCUPADO" <<< "$out" && nothing_deleted'
release_locks
seed; hold_lock "$RR/.prepare.lock" -s
out="$(clean "$ID" ejecutar 4000)"; rc=$?
check "armado de una release en curso => ocupado, nada borrado" '[ $rc = 6 ] && grep -q "preparando una versión" <<< "$out" && nothing_deleted'
release_locks
seed; hold_lock "$RR/.prepare.lock"
out="$(clean "$ID" ejecutar 4000)"; rc=$?
check "otra limpieza en curso => ocupado, nada borrado" '[ $rc = 6 ] && nothing_deleted'
# El armado (remote-assemble) respeta la limpieza en curso: se detiene antes de crear nada.
mkdir -p "$RR/incoming-20261124-150000"
before="$(ls "$RR" | wc -l)"
out="$(cat "$SRC/remote-lib.sh" "$SRC/remote-assemble.sh" | tr -d '\r' | bash -s -- "$(printf 'a%.0s' $(seq 40))" "$RR/incoming-20261124-150000" 2>&1)"; rc=$?
check "armado con limpieza en curso => se detiene sin crear release" '[ $rc = 1 ] && grep -q "limpieza de releases en curso" <<< "$out" && [ "$(ls "$RR" | wc -l)" = "$before" ]'
release_locks
seed; echo "$RR/$RB" > "$ST/switch_on_mv"
out="$(clean "$ID" ejecutar 4000)"; rc=$?
check "la versión activa cambia en plena limpieza => se detiene (rc 8) sin seguir borrando" '[ $rc = 8 ] && grep -q "versión activa cambió" <<< "$out" && [ "$(grep -c "^eliminada " <<< "$out")" -le 1 ] && all_exist "${PROTECTED[@]}"'

echo "6. Fallos durante la limpieza"
seed; echo "$OLD2" > "$ST/fail_rm"
out="$(clean "$ID" ejecutar 0)"; rc=$?
check "rm falla en una release => rc 8 (parcial), el resto se borra" '[ $rc = 8 ] && grep -q "^LIMPIEZA resultado=parcial " <<< "$out" && none_exist "$OLD1" "$DUP" && all_exist "${PROTECTED[@]}"'
check "la release a medias queda apartada como .trash-* (nunca con su nombre)" '! exists "$OLD2" && ls -A "$RR" | grep -q "^\.trash-$OLD2-"'
rm -f "$ST/fail_rm"
out="$(clean "$ID" ejecutar 0)"; rc=$?
check "la siguiente limpieza termina de borrar el resto apartado" '[ $rc = 0 ] && [ -z "$(ls -A "$RR" | grep "^\.trash-")" ] && all_exist "${PROTECTED[@]}"'
seed; echo "$OLD1" > "$ST/fail_mv"
out="$(clean "$ID" ejecutar 0)"; rc=$?
check "no se puede apartar (mv falla) => se conserva intacta, rc 8" '[ $rc = 8 ] && exists "$OLD1" && [ -f "$RR/$OLD1/.release-info" ] && none_exist "$OLD2"'
seed; echo 1200 > "$ST/free_mb"
out="$(clean "$ID" ejecutar 4000)"; rc=$?
check "libre insuficiente tras limpiar => rc 7 (insuficiente) y protegidas intactas" '[ $rc = 7 ] && grep -q "^LIMPIEZA resultado=insuficiente " <<< "$out" && all_exist "${PROTECTED[@]}"'
seed
out="$(clean "$ID" ejecutar abc)"; rc=$?
check "argumentos inválidos => rc 1 sin borrar" '[ $rc = 1 ] && nothing_deleted'
out="$(clean "$ID" borrar-todo 0)"; rc=$?
check "modo inválido => rc 1 sin borrar" '[ $rc = 1 ] && nothing_deleted'

echo
echo "RESULTADO LIMPIEZA: $PASS OK, $FAIL fallos"
[ "$FAIL" = 0 ]
