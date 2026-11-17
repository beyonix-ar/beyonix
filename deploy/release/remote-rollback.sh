# VPS — Vuelve a una versión anterior YA COMPILADA y verificada (se envía detrás de remote-lib.sh).
# No recompila ni toca la base de datos.
# Uso: remote-rollback.sh <deploy-id> <activa-esperada|-> <destino|->
#   activa-esperada: sólo revierte si la versión activa sigue siendo ésa (evita revertir tarde
#                    sobre el despliegue de otro). "-" = sin condición (rollback manual).
#   destino: release verificada; "-" = la previa al último despliegue de .deploy-history.
# Códigos: 0 OK · 5 OK pero `pm2 save` falló · 3 no se pudo volver y se mantuvo la que estaba ·
#          4 ALERTA CRÍTICA · 1 rechazado sin tocar nada.
# La versión original del VPS (~/apps/beyonix, sin .release-info) NO se acepta acá: se recupera con
# el mecanismo previo `release-rollback.sh --restore-original-pm2` (ver README).

main() {
  [ $# -eq 3 ] || stop "uso: remote-rollback.sh <deploy-id> <activa-esperada|-> <destino|->"
  local id="$1" expected="$2" requested="$3" active target target_build active_build last
  [[ "$id" =~ $DEPLOY_ID_RE ]] || stop "deploy-id inválido"
  open_run_log "$id" rollback
  acquire_switch_lock || stop "otro cambio de versión está en curso"

  [ -L "$CURRENT" ] || stop "no existe el enlace $CURRENT"
  active="$(readlink -f "$CURRENT")"
  if [ "$expected" != - ]; then
    [ "$(realpath -e -- "$expected" 2>/dev/null)" = "$active" ] \
      || stop "la versión activa ya no es la esperada ($active); no se revierte"
  fi

  if [ "$requested" = - ]; then
    [ -s "$HISTORY" ] || stop "no hay despliegues registrados; indicá la versión destino"
    last="$(grep -F " new=$active " "$HISTORY" | tail -n 1)"
    [ -n "$last" ] || stop "la versión activa no figura en el historial; indicá la versión destino"
    requested="$(sed -E 's/.* prev=([^ ]+) .*/\1/' <<< "$last")"
  fi
  target="$(validate_release "$requested")" || stop "versión destino no apta: $INVALID_REASON"
  [ "$target" != "$active" ] || stop "esa versión ya está activa"
  target_build="$(cat "$target/.next/BUILD_ID")"
  active_build="$(cat "$active/.next/BUILD_ID" 2>/dev/null)"
  say "activa=$active destino=$target build_destino=$target_build"

  point_current "$target" || { point_current "$active"; stop "no se pudo mover el enlace (sin cambios)"; }
  if restart_service && health "$target_build"; then
    echo "$(date -Is) prev=$active new=$target build=$target_build id=$id rollback" >> "$HISTORY"
    if "$PM2" save >/dev/null 2>&1; then
      write_result "$id" ROLLBACK_MANUAL_OK "build=$target_build"
      say "ROLLBACK OK build_id=$target_build"
      exit 0
    fi
    write_result "$id" ROLLBACK_MANUAL_SIN_SAVE "build=$target_build"
    say "AVISO: versión restaurada y sana, pero pm2 save falló"
    say "ROLLBACK OK build_id=$target_build pm2_save=FALLO"
    exit 5
  fi

  say "la versión destino no respondió; volviendo a la que estaba ($active)"
  if [ -n "$active_build" ] && recover_to "$active" "$active_build"; then
    "$PM2" save >/dev/null 2>&1 || say "AVISO: pm2 save falló tras la recuperación"
    write_result "$id" ROLLBACK_FALLIDO_SIN_CAMBIOS "destino sin salud"
    say "ROLLBACK FALLIDO: se mantuvo la versión que estaba (build $active_build)"
    exit 3
  fi
  write_result "$id" CRITICO "rollback: ni el destino ni la versión previa respondieron"
  say "ALERTA CRÍTICA: ni la versión destino ni la que estaba responden. BEYONIX puede estar caído: revisar YA con 'pm2 list' y 'pm2 logs beyonix'."
  exit 4
}

main "$@"
