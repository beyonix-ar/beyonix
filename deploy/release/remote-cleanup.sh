# VPS — Limpieza segura de releases viejas (se envía concatenado detrás de remote-lib.sh).
# Uso: remote-cleanup.sh <deploy-id> <simular|ejecutar> <libre-mínimo-mb>
#
# Política de retención (todo lo demás que coincida con los patrones de abajo se elimina):
#   * la release activa (destino de beyonix-current) y el directorio de PM2;
#   * la de rollback: el "prev=" de la última línea de .deploy-history que activó la actual
#     (la misma que usa `-Rollback` sin versión). Si falta, no es válida o no es esa carpeta
#     real, la limpieza se detiene sin borrar nada;
#   * las preparadas pendientes: verificadas (.release-info) DESPUÉS de activar la actual; de
#     cada commit se conserva la más nueva;
#   * un respaldo adicional: la release verificada más nueva que no entra en lo anterior;
#   * todo lo que está en preparación: directorios sin .release-info o incoming-* de menos de
#     CLEANUP_GRACE_SECONDS, y los incoming-* que guardan el manifest de una release conservada.
# Sólo se consideran directorios (no enlaces) directamente en beyonix-releases con nombre de
# release (<sha7>-<fecha>-<hora>), incoming-<fecha>-<hora> o .trash-* (restos de una limpieza
# interrumpida). Nunca toca ~/apps/beyonix, .env.local, backups, ~/rollback, logs ni el historial.
#
# Concurrencia: toma el bloqueo de cambios de versión (switch/rollback) y el de armado en modo
# exclusivo; si alguno está tomado no borra nada. Cada eliminación primero RENOMBRA el directorio a
# .trash-* (atómico) y recién después lo borra: un corte deja basura reconocible, nunca una
# release a medias con su nombre original.
# Códigos: 0 OK y libre >= mínimo · 7 terminó pero el libre sigue < mínimo · 8 algo no se pudo
#          borrar · 6 ocupado (otro cambio o armado en curso; nada borrado) · 1 detenido (estado
#          no confiable; nada borrado).
# Última línea: LIMPIEZA resultado=<ok|simulada|parcial|insuficiente> eliminadas=N liberado_mb=N libre_mb=N

KEEP_EXTRA=1
declare -A KEEP=()
CANDIDATES=()

keep() { # keep <ruta> <motivo>: la primera razón gana
  [ -n "${KEEP[$1]:-}" ] || KEEP[$1]="$2"
}
busy() { say "OCUPADO: $*"; say "LIMPIEZA resultado=ocupado eliminadas=0 liberado_mb=0 libre_mb=$(disk_free_mb)"; exit 6; }
epoch_of() { date -d "$1" +%s 2>/dev/null; }
mtime_of() { stat -c %Y -- "$1" 2>/dev/null; }
size_mb() { nice -n 19 du -sm -- "$1" 2>/dev/null | cut -f1; }
is_plain_dir_in_root() { # directorio real (no enlace) directamente dentro de REL_ROOT
  [ -d "$1" ] && [ ! -L "$1" ] && [ "$(realpath -e -- "$1" 2>/dev/null)" = "$1" ] && [ "${1%/*}" = "$REL_ROOT" ]
}

main() {
  [ $# -eq 3 ] || stop "uso: remote-cleanup.sh <deploy-id> <simular|ejecutar> <libre-mínimo-mb>"
  local id="$1" mode="$2" min="$3" active info cwd last rollback activated_at now d name prepared sha p
  [[ "$id" =~ $DEPLOY_ID_RE ]] || stop "deploy-id inválido"
  [[ "$mode" =~ ^(simular|ejecutar)$ ]] || stop "modo inválido"
  [[ "$min" =~ ^[0-9]{1,7}$ ]] || stop "libre mínimo inválido"
  open_run_log "$id" cleanup
  [ -d "$REL_ROOT" ] && [ ! -L "$REL_ROOT" ] || stop "no existe $REL_ROOT"

  acquire_switch_lock || busy "hay un cambio de versión en curso; no se borra nada"
  acquire_prepare_lock_exclusive || busy "se está preparando una versión (u otra limpieza está en curso); no se borra nada"

  # ── Qué está en uso ─────────────────────────────────────────────────────────
  [ -L "$CURRENT" ] || stop "no existe el enlace $CURRENT"
  active="$(readlink -f "$CURRENT")"
  [ "${active%/*}" = "$REL_ROOT" ] && [[ "${active##*/}" =~ $RELEASE_NAME_RE ]] && [ -d "$active" ] \
    || stop "la versión activa ($active) no es una release de $REL_ROOT"
  info="$(pm2_info)"
  case "$info" in error|ausente) stop "PM2 no informa el proceso beyonix ($info)" ;; esac
  cwd="$(cut -d' ' -f3 <<< "$info")"
  [ "$cwd" = "$CURRENT" ] || stop "PM2 no usa $CURRENT como directorio ($cwd)"
  keep "$active" "activa"

  last="$( { grep -F " new=$active " "$HISTORY" 2>/dev/null || true; } | tail -n 1)"
  [ -n "$last" ] || stop "la versión activa no figura en .deploy-history: no se puede saber cuál es el rollback"
  rollback="$(sed -nE 's/.* prev=([^ ]+) .*/\1/p' <<< "$last")"
  activated_at="$(epoch_of "${last%% *}")" || stop "fecha ilegible en .deploy-history"
  [ -n "$activated_at" ] || stop "fecha ilegible en .deploy-history"
  # El rollback registrado tiene que existir y ser utilizable (la misma validación que exige
  # -Rollback). Si falta o está dañado, no se borra nada: lo que quede puede ser la única salida.
  [ -n "$rollback" ] || stop "la línea de .deploy-history de la versión activa no registra el rollback (prev=); no se borra nada"
  p="$(validate_release "$rollback")" \
    || stop "la release de rollback registrada ($rollback) no existe o no es válida ($INVALID_REASON); no se borra nada"
  [ "$p" = "$rollback" ] && [ ! -L "$rollback" ] \
    || stop "la release de rollback registrada ($rollback) no es una carpeta real (resuelve a $p); no se borra nada"
  keep "$p" "rollback"
  now="$(date +%s)"

  # ── Releases ────────────────────────────────────────────────────────────────
  local -A newest_pending=() newest_pending_at=()
  local old_verified=()
  for d in "$REL_ROOT"/*; do
    name="${d##*/}"
    [[ "$name" =~ $RELEASE_NAME_RE ]] || continue
    is_plain_dir_in_root "$d" || { say "AVISO: se ignora $name (no es un directorio normal)"; continue; }
    [ -n "${KEEP[$d]:-}" ] && continue
    if [ -f "$d/.release-info" ]; then
      prepared="$(epoch_of "$(sed -n 's/^prepared_at=//p' "$d/.release-info")")"
      sha="$(sed -n 's/^sha=//p' "$d/.release-info")"
      if [ -z "$prepared" ] || [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
        keep "$d" "release-info ilegible (no se decide sin datos)"
      elif [ "$prepared" -gt "$activated_at" ]; then
        if [ -z "${newest_pending[$sha]:-}" ] || [ "$prepared" -gt "${newest_pending_at[$sha]}" ]; then
          [ -n "${newest_pending[$sha]:-}" ] && CANDIDATES+=("${newest_pending[$sha]}|preparada reemplazada por otra más nueva del mismo commit")
          newest_pending[$sha]="$d"; newest_pending_at[$sha]="$prepared"
        else
          CANDIDATES+=("$d|preparada reemplazada por otra más nueva del mismo commit")
        fi
      else
        old_verified+=("$prepared $d")
      fi
    else
      p="$(mtime_of "$d")"
      if [ -z "$p" ] || [ $((now - p)) -lt "$CLEANUP_GRACE_SECONDS" ]; then
        keep "$d" "en preparación (sin .release-info, reciente)"
      else
        CANDIDATES+=("$d|incompleta (nunca se verificó)")
      fi
    fi
  done
  for d in "${newest_pending[@]}"; do keep "$d" "preparada pendiente de activación"; done

  # Respaldo adicional: la verificada más nueva (que además valide completa) entre las viejas, de
  # un commit distinto a los ya conservados (una copia del mismo commit no agrega nada).
  local extra=0 line kept_shas=" "
  for d in "${!KEEP[@]}"; do
    [ -f "$d/.release-info" ] && kept_shas+="$(sed -n 's/^sha=//p' "$d/.release-info") "
  done
  while read -r line; do
    [ -n "$line" ] || continue
    d="${line#* }"
    sha="$(sed -n 's/^sha=//p' "$d/.release-info")"
    if [ "$extra" -lt "$KEEP_EXTRA" ] && [[ "$kept_shas" != *" $sha "* ]] && validate_release "$d" >/dev/null; then
      keep "$d" "respaldo adicional"; extra=$((extra + 1)); kept_shas+="$sha "
    else
      CANDIDATES+=("$d|vieja (no es activa, rollback, pendiente ni respaldo)")
    fi
  done < <(printf '%s\n' "${old_verified[@]}" | sort -rn)

  # ── incoming-* y restos de limpiezas interrumpidas ──────────────────────────
  local kept_builds=" " build
  for d in "${!KEEP[@]}"; do
    [ -f "$d/.release-info" ] && kept_builds+="$(sed -n 's/^build_id=//p' "$d/.release-info") "
  done
  for d in "$REL_ROOT"/incoming-*; do
    name="${d##*/}"
    [[ "$name" =~ ^incoming-[0-9]{8}-[0-9]{6}$ ]] && is_plain_dir_in_root "$d" || continue
    p="$(mtime_of "$d")"
    build="$(sed -n 's/^build_id=//p' "$d/meta.env" 2>/dev/null)"
    if [ -z "$p" ] || [ $((now - p)) -lt "$CLEANUP_GRACE_SECONDS" ]; then
      keep "$d" "recepción reciente (deploy en curso)"
    elif [ -n "$build" ] && [[ "$kept_builds" == *" $build "* ]]; then
      keep "$d" "artefacto de una release conservada"
    else
      CANDIDATES+=("$d|artefacto transferido de una release ya eliminada o descartada")
    fi
  done
  for d in "$REL_ROOT"/.trash-*; do
    is_plain_dir_in_root "$d" || continue
    CANDIDATES+=("$d|resto de una limpieza interrumpida")
  done

  # ── Plan ────────────────────────────────────────────────────────────────────
  local free_before entry path why mb deleted=0 freed=0 failed=0 planned=0 tmp
  free_before="$(disk_free_mb)"
  say "limpieza modo=$mode libre_mb=$free_before minimo_mb=$min activa=$active rollback=${rollback:-ninguno}"
  for d in "${!KEEP[@]}"; do say "CONSERVAR ${d##*/} motivo=${KEEP[$d]}"; done | sort
  for entry in "${CANDIDATES[@]}"; do
    path="${entry%%|*}"
    # Nunca algo conservado (doble control) ni fuera de REL_ROOT.
    [ -z "${KEEP[$path]:-}" ] && [ "${path%/*}" = "$REL_ROOT" ] || continue
    mb="$(size_mb "$path")"
    planned=$((planned + ${mb:-0}))
    say "ELIMINAR ${path##*/} mb=${mb:-?} motivo=${entry#*|}"
  done

  if [ "$mode" = simular ]; then
    say "LIMPIEZA resultado=simulada eliminadas=0 liberado_mb=0 libre_mb=$free_before liberable_mb=$planned"
    exit 0
  fi

  # ── Ejecución ───────────────────────────────────────────────────────────────
  for entry in "${CANDIDATES[@]}"; do
    path="${entry%%|*}"; why="${entry#*|}"
    [ -z "${KEEP[$path]:-}" ] && [ "${path%/*}" = "$REL_ROOT" ] || continue
    # La activa no puede haber cambiado (tenemos el bloqueo), pero se vuelve a comprobar.
    [ "$(readlink -f "$CURRENT")" = "$active" ] || { say "DETENER: la versión activa cambió durante la limpieza"; failed=$((failed + 1)); break; }
    is_plain_dir_in_root "$path" || continue
    mb="$(size_mb "$path")"; mb="${mb:-0}"
    tmp="$path"
    if [[ "${path##*/}" != .trash-* ]]; then
      tmp="$REL_ROOT/.trash-${path##*/}-$$"
      if ! "$MV" -T -- "$path" "$tmp" 2>/dev/null; then
        say "ERROR: no se pudo apartar ${path##*/} (se conserva)"; failed=$((failed + 1)); continue
      fi
    fi
    if "$RM" -rf -- "$tmp" 2>/dev/null && [ ! -e "$tmp" ]; then
      deleted=$((deleted + 1)); freed=$((freed + mb))
      say "eliminada ${path##*/} mb=$mb"
      printf '%s id=%s eliminada=%s mb=%s motivo=%s\n' "$(date -Is)" "$id" "${path##*/}" "$mb" "$why" >> "$CLEANUP_HISTORY" 2>/dev/null
    else
      say "ERROR: no se pudo borrar por completo ${tmp##*/} (queda apartado; se reintenta en la próxima limpieza)"
      failed=$((failed + 1))
    fi
  done

  local free_after result=ok code=0
  free_after="$(disk_free_mb)"
  if [ "$failed" -gt 0 ]; then result=parcial; code=8
  elif [ "$free_after" -lt "$min" ]; then result=insuficiente; code=7
  fi
  printf '%s id=%s resultado=%s eliminadas=%s liberado_mb=%s libre_antes_mb=%s libre_mb=%s\n' \
    "$(date -Is)" "$id" "$result" "$deleted" "$freed" "$free_before" "$free_after" >> "$CLEANUP_HISTORY" 2>/dev/null
  say "LIMPIEZA resultado=$result eliminadas=$deleted liberado_mb=$freed libre_mb=$free_after"
  exit "$code"
}

main "$@"
