# VPS — Arma una release NUEVA con el .next compilado en la PC y la verifica en 127.0.0.1:3001
# (se envía concatenado detrás de remote-lib.sh).
# No toca la release activa, el enlace beyonix-current, PM2 ni la base de datos (el humo sólo hace GET).
# Uso: remote-assemble.sh <sha-completo> <dir-incoming>
# Última línea si todo pasa: LISTO release=<ruta> build_id=<id>

first() { sed -n 1p; }
# Tiempos por etapa ("tiempo <clave>=<ms>"): sólo informativos, no cambian ninguna decisión.
T_LAP="$(date +%s%3N)"
lap() { local now; now="$(date +%s%3N)"; say "tiempo $1=$((now - T_LAP))"; T_LAP="$now"; }

# npm ci aislado en un scope de systemd con memoria máxima: si la supera, el kernel mata sólo a
# npm (nunca a PM2, que está en otro cgroup) y la preparación se detiene.
limited_npm_ci() { # limited_npm_ci <dir>
  local avail
  avail="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
  [ "$avail" -ge "$NPM_CI_MIN_AVAILABLE_MB" ] || { say "memoria disponible ${avail} MB < ${NPM_CI_MIN_AVAILABLE_MB} MB"; return 1; }
  (cd "$1" && systemd-run --user --scope --quiet \
      -p MemoryMax="$NPM_CI_MEMORY_MAX" -p MemorySwapMax=0 -p CPUWeight=20 \
      nice -n 15 "$NPM_BIN" ci --no-audit --no-fund --loglevel=error)
}

main() {
  [ $# -eq 2 ] || stop "uso: remote-assemble.sh <sha> <incoming>"
  local sha="$1" in active active_build_before expected_build rel new_build win_refs outside
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || stop "SHA inválido"
  in="$(realpath -e -- "$2" 2>/dev/null)" || stop "incoming inexistente"
  [ "${in%/*}" = "$REL_ROOT" ] && [[ "${in##*/}" =~ ^incoming-[0-9]{8}-[0-9]{6}$ ]] || stop "incoming fuera de $REL_ROOT/incoming-*"
  # Mientras se arma (hasta terminar el proceso), la limpieza automática no puede borrar nada.
  acquire_prepare_lock_shared || stop "hay una limpieza de releases en curso; volvé a intentar en unos minutos"

  [ -L "$CURRENT" ] || stop "no existe el enlace $CURRENT"
  active="$(readlink -f "$CURRENT")"
  active_build_before="$(cat "$active/.next/BUILD_ID")"
  say "activa=$active build_activo=$active_build_before"

  # 1. Integridad del artefacto transferido.
  (cd "$in" && sha256sum -c --quiet SHA256SUMS) || stop "SHA256SUMS no coincide (transferencia corrupta)"
  grep -qx "sha=$sha" "$in/meta.env" || stop "el artefacto no corresponde a $sha"
  expected_build="$(sed -n 's/^build_id=//p' "$in/meta.env")"
  gzip -t "$in/next-build.tar.gz" || stop "tar.gz dañado"
  outside="$( { tar -tzf "$in/next-build.tar.gz" | grep -vE '^\.next(/|$)' || true; } | wc -l)"
  [ "$outside" = 0 ] || stop "el tar contiene rutas fuera de .next"
  [ "$(df --output=avail -m "$APPS" | tail -1 | tr -d ' ')" -ge 3000 ] || stop "menos de 3 GB libres en el VPS"
  say "artefacto=OK build_esperado=$expected_build"
  lap vps_artefacto

  # 2. Release nueva (nunca reutiliza ni pisa un directorio existente).
  rel="$REL_ROOT/${sha:0:7}-$(date +%Y%m%d-%H%M%S)"
  mkdir "$rel" || stop "no se pudo crear $rel"
  say "release=$rel"
  git clone --quiet --no-checkout "$(git -C "$active" remote get-url origin)" "$rel" || stop "git clone falló"
  git -C "$rel" checkout --quiet --detach "$sha" || stop "checkout falló"
  [ "$(git -C "$rel" rev-parse HEAD)" = "$sha" ] || stop "checkout no coincide"
  lap vps_codigo

  # Dependencias Linux: mismo lock que la activa => copia (probado); lock distinto => npm ci limitado.
  if cmp -s "$active/package-lock.json" "$rel/package-lock.json"; then
    nice -n 15 ionice -c3 cp -a "$active/node_modules" "$rel/node_modules" || stop "copia de node_modules falló"
    say "dependencias=copiadas de la release activa (mismo package-lock)"
  else
    say "dependencias=package-lock cambió: npm ci (máx. $NPM_CI_MEMORY_MAX)"
    limited_npm_ci "$rel" || stop "npm ci falló o superó el límite de memoria (la versión activa no se tocó)"
  fi
  ln -s "$ENV_FILE" "$rel/.env.local" || stop "no se pudo enlazar .env.local"
  [ -r "$rel/.env.local" ] || stop ".env.local no legible por enlace"
  lap vps_dependencias

  # 3. Extraer el build y verificar archivo por archivo; el manifest queda en la release para
  #    poder validarla en un rollback futuro.
  tar -xzf "$in/next-build.tar.gz" -C "$rel" || stop "no se pudo extraer el build"
  (cd "$rel" && sha256sum -c --quiet "$in/next-files.sha256") || stop "manifest de archivos no coincide"
  cp "$in/next-files.sha256" "$rel/.next-files.sha256" || stop "no se pudo guardar el manifest"
  new_build="$(cat "$rel/.next/BUILD_ID")"
  [ "$new_build" = "$expected_build" ] || stop "BUILD_ID inesperado"
  [ "$new_build" != "$active_build_before" ] || stop "el BUILD_ID es igual al activo"
  win_refs="$( { grep -rlaE 'win32-x64|sharp-win32|[A-Z]:(\\\\|/)(BEYONIX|Users)' "$rel/.next/server" "$rel/.next/static" --include=*.js || true; } | wc -l)"
  [ "$win_refs" = 0 ] || stop "runtime con $win_refs archivos con referencias Windows"
  (cd "$rel" && node -e 'require("sharp")') || stop "sharp (Linux) no carga"
  say "integridad=OK"
  lap vps_extraccion

  # 4. La versión activa sigue intacta.
  [ "$(readlink -f "$CURRENT")" = "$active" ] || stop "el enlace activo cambió durante el armado"
  [ "$(cat "$active/.next/BUILD_ID")" = "$active_build_before" ] || stop "el build activo cambió"

  # 5. Humo en 127.0.0.1:3001: sólo GET, sin seguir redirecciones, comparando con producción (:3000).
  #    RuntimeMaxSec: aunque se corte la conexión, systemd apaga el server de humo solo.
  local unit="beyonix-smoke-$(date +%s)" smoke_log="$rel/.smoke-server.log" home_html code mismatch=0 p new old flag css_path img_path img
  systemd-run --user --quiet --unit "$unit" -p MemoryMax=900M -p RuntimeMaxSec=600 --working-directory="$rel" \
    -p StandardOutput="append:$smoke_log" -p StandardError="append:$smoke_log" \
    /usr/bin/env PORT=3001 /usr/bin/node "$rel/node_modules/next/dist/bin/next" start -H 127.0.0.1 -p 3001 \
    || stop "no se pudo iniciar el server de humo"
  cleanup_smoke() {
    systemctl --user stop "$unit" 2>/dev/null || true
    systemctl --user reset-failed "$unit" 2>/dev/null || true
  }
  trap cleanup_smoke EXIT
  home_html="$(mktemp)"
  code=000
  for _ in $(seq 1 60); do
    code="$(curl -s -o "$home_html" -w '%{http_code}' --max-time 10 http://127.0.0.1:3001/ || true)"
    [ "$code" = 200 ] && break
    sleep 1
  done
  [ "$code" = 200 ] || stop "humo: GET / devolvió $code"
  grep -qF "$new_build" "$home_html" || stop "humo: el HTML no sirve el BUILD_ID nuevo"

  for p in / /productos /categorias /contacto /privacidad /terminos /sobre-nosotros /devoluciones /arrepentimiento \
           /login /recuperar-contrasena /checkout /cuenta /admin /admin/pedidos /admin/despachos /ruta-inexistente-humo; do
    new="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:3001$p" || echo ERR)"
    old="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:3000$p" || echo ERR)"
    flag=OK
    [ "$new" = "$old" ] || { flag=DIFIERE; mismatch=$((mismatch + 1)); }
    case "$new" in 5*|ERR) flag=ERROR; mismatch=$((mismatch + 1)) ;; esac
    say "humo $p nuevo=$new activo=$old $flag"
  done
  css_path="$( { grep -oE '/_next/static/chunks/[^"]+\.css' "$home_html" || true; } | first)"
  [ -n "$css_path" ] || stop "humo: la home no referencia CSS"
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:3001$css_path")" = 200 ] || stop "humo: CSS no servido"
  img_path="$( { grep -oE '/_next/image\?url=[^"&]+(&amp;|&)w=[0-9]+(&amp;|&)q=[0-9]+' "$home_html" || true; } | first | sed 's/&amp;/\&/g')"
  if [ -n "$img_path" ]; then
    img="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 30 "http://127.0.0.1:3001$img_path")"
    say "humo imagen optimizada: $img"
    case "$img" in 200\ image/*) ;; *) mismatch=$((mismatch + 1)) ;; esac
  fi
  grep -q "Ready in" "$smoke_log" || { say "humo: el server no informó 'Ready in'"; mismatch=$((mismatch + 1)); }
  if grep -qiE 'error|unhandled|cannot find module' "$smoke_log"; then
    say "$(grep -iE 'error|unhandled|cannot find module' "$smoke_log" | tail -5)"
    mismatch=$((mismatch + 1))
  fi
  cleanup_smoke
  trap - EXIT
  rm -f "$home_html"
  [ "$mismatch" = 0 ] || stop "$mismatch diferencias/errores en el humo (ver arriba)"
  lap vps_humo

  {
    echo "sha=$sha"
    echo "build_id=$new_build"
    echo "prepared_at=$(date -Is)"
    echo "build_source=externo ($(sed -n 's/^build_platform=//p' "$in/meta.env"))"
    echo "active_build_id_at_prepare=$active_build_before"
  } > "$rel/.release-info" || stop "no se pudo escribir .release-info"
  say "LISTO release=$rel build_id=$new_build"
}

main "$@"
