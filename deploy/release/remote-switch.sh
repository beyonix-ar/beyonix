# VPS — Activa una release verificada (se envía concatenado detrás de remote-lib.sh).
# Uso: remote-switch.sh <ruta-release> <ruta-activa-esperada> <deploy-id>
# Todo ocurre bajo el bloqueo de cambios de versión: comprobación de la versión activa, cambio,
# verificación de estabilidad y, si algo falla, vuelta a la versión anterior.
# Códigos: 0 activada · 5 activada pero `pm2 save` falló · 3 falló y se recuperó la anterior ·
#          4 ALERTA CRÍTICA (no se pudo recuperar) · 1 rechazada sin tocar nada.
# El resultado queda además en .last-switch (por si se corta la conexión).

main() {
  [ $# -eq 3 ] || stop "uso: remote-switch.sh <release> <activa-esperada> <deploy-id>"
  local id="$3" expected rel active prev_build new_build restarts_after errs_before new_errs reason="" pub i
  [[ "$id" =~ $DEPLOY_ID_RE ]] || stop "deploy-id inválido"
  open_run_log "$id" switch
  acquire_switch_lock || stop "otro cambio de versión está en curso"

  rel="$(validate_release "$1")" || stop "release no apta: $INVALID_REASON"
  expected="$(realpath -e -- "$2" 2>/dev/null)" || stop "versión activa esperada inexistente"
  [ -L "$CURRENT" ] || stop "no existe el enlace $CURRENT"
  active="$(readlink -f "$CURRENT")"
  [ "$active" = "$expected" ] || stop "la versión activa cambió (esperada $expected, actual $active)"
  [ "$rel" != "$active" ] || stop "esa release ya está activa"
  [ "$(pm2_cwd)" = "$CURRENT" ] || stop "PM2 no usa $CURRENT como directorio"
  [ "$(pm2_status)" = online ] || stop "BEYONIX no está online; no se activa nada"
  prev_build="$(cat "$active/.next/BUILD_ID")"
  new_build="$(cat "$rel/.next/BUILD_ID")"

  mkdir -p "$ROLLBACK_DIR" && local bk="$ROLLBACK_DIR/$(date +%Y%m%d-%H%M%S)-pm2-$id-$$" \
    && mkdir -m 700 "$bk" && cp -a "$PM2_DUMP" "$bk/dump.pm2" \
    && printf 'prev_target=%s\nnew_target=%s\n' "$active" "$rel" > "$bk/switch.env" \
    || stop "no se pudo respaldar la configuración de PM2"
  errs_before="$(wc -l < "$PM2_ERROR_LOG" 2>/dev/null || echo 0)"
  say "previa=$active build_previo=$prev_build"
  say "nueva=$rel build_nuevo=$new_build pm2_backup=$bk"

  point_current "$rel" || { point_current "$active"; stop "no se pudo mover el enlace activo (sin cambios)"; }

  if ! "$PM2" restart beyonix >/dev/null 2>&1; then
    reason="pm2 restart falló"
  elif ! health "$new_build"; then
    reason="la versión nueva no respondió"
  else
    restarts_after="$(pm2_restarts)"
    sleep "$STABILITY_SECONDS"
    if [ "$(pm2_status)" != online ]; then
      reason="el proceso no quedó online"
    elif [ "$(pm2_restarts)" != "$restarts_after" ]; then
      reason="el proceso se reinició solo"
    else
      new_errs="$(tail -n "+$((errs_before + 1))" "$PM2_ERROR_LOG" 2>/dev/null || true)"
      if grep -qiE 'cannot find module|ChunkLoadError|failed to load chunk|unhandled|EADDRINUSE' <<< "$new_errs"; then
        reason="errores críticos en los logs"
      else
        pub=0
        for ((i = 0; i < HEALTH_TRIES; i++)); do
          "$CURL" -s --max-time 10 "$PUBLIC_URL" 2>/dev/null | grep -qF "$new_build" && { pub=1; break; }
          sleep 1
        done
        [ "$pub" = 1 ] || reason="el sitio público no sirve la versión nueva"
      fi
    fi
  fi

  if [ -z "$reason" ]; then
    echo "$(date -Is) prev=$active new=$rel build=$new_build id=$id" >> "$HISTORY"
    if "$PM2" save >/dev/null 2>&1; then
      write_result "$id" ACTIVADA "build=$new_build"
      say "ACTIVADA release=$rel build_id=$new_build"
      exit 0
    fi
    write_result "$id" ACTIVADA_SIN_SAVE "build=$new_build"
    say "AVISO: versión nueva activa y sana, pero pm2 save falló (tras reiniciar el VPS, revisar con pm2 list)"
    say "ACTIVADA release=$rel build_id=$new_build pm2_save=FALLO"
    exit 5
  fi

  say "ROLLBACK: $reason; volviendo a $active"
  if recover_to "$active" "$prev_build"; then
    "$PM2" save >/dev/null 2>&1 || say "AVISO: pm2 save falló tras la recuperación"
    write_result "$id" ROLLBACK_OK "$reason"
    say "ROLLBACK OK build_id=$prev_build"
    exit 3
  fi
  write_result "$id" CRITICO "$reason; la versión anterior tampoco respondió"
  say "ALERTA CRÍTICA: la versión nueva falló ($reason) y la anterior no se pudo recuperar. BEYONIX puede estar caído: revisar YA con 'pm2 list' y 'pm2 logs beyonix'."
  exit 4
}

main "$@"
