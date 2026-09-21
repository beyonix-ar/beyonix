# Baseline técnico del 21 de septiembre de 2026

`production-schema-2026-09-21.sql` es el snapshot **schema-only** del proyecto
productivo vinculado, extraído con `pg_dump` 17.11 desde PostgreSQL 17.6 y con
`default_transaction_read_only=on`. No es una migración y no debe aplicarse sobre
producción ni agregarse al historial de `supabase/migrations/`.

El JSON adjunto registra SHA-256 del SQL, fecha de captura, roles sin contraseñas,
membresías, extensiones y versiones de migraciones ya aplicadas. El último punto
aplicado es `20260922130000`; las tres migraciones `20260923100000`,
`20260923110000` y `20260923120000` quedan fuera del snapshot.

Se capturan `public`, `auth`, `storage` y `extensions`: estructura, funciones,
triggers, constraints, índices, tipos, secuencias, RLS, policies y grants. No se
incluyen filas, credenciales ni contraseñas de roles. Los datos sintéticos del
verificador se crean únicamente después de restaurar la base local vacía.
Los servicios gestionados de Supabase, el contenido de Storage y los esquemas
de plataforma `vault`, `realtime` y `supabase_migrations` no se reconstruyen.

## Reproducción local

Requiere dependencias del repositorio y binarios PostgreSQL 17, incluidas las
extensiones estándar `pg_stat_statements`, `pgcrypto` y `uuid-ossp` con las
versiones del JSON. En PowerShell:

```powershell
$env:BEYONIX_PG_BIN = 'C:/ruta/postgresql17/bin'
node supabase/baselines/verify-production-schema.mjs
node --check supabase/baselines/verify-production-schema.mjs
git diff --check
```

El verificador sólo acepta una carpeta de binarios; no acepta URL de conexión.
Crea un cluster temporal nuevo, escucha en loopback y se detiene al terminar.
Conserva el directorio temporal y `verification.json` como evidencia local.
Los roles y sus atributos se reconstruyen a partir del catálogo capturado; el
otorgante de las membresías es el administrador del cluster local. No se cargan
contraseñas. Se conservan las opciones ADMIN, INHERIT y SET.

Primero se comprueban 91 tablas vacías y la equivalencia del dump restaurado.
La comparación normaliza CRLF, cabeceras de versión, tokens de control de psql,
orden de roles y grants, y dos paréntesis redundantes de un CHECK que PostgreSQL
17.11 serializa de otra forma. No omite cuerpos de funciones ni reglas de acceso.
Se reinstalan las extensiones registradas, excluidas por `pg_dump --schema`, y
el permiso USAGE público que PostgreSQL otorga inicialmente al esquema `public`.

Después se aplican **solamente las tres migraciones pendientes**, en orden. Las
pruebas utilizan tablas, funciones, RLS y triggers reales del snapshot: permisos
ARCA, alta externa idempotente, edición/reversión y confirmación/cancelación con
dos conexiones independientes y comprobación de espera real por locks. Verifican
también importes, vinculación del reintegro al débito, saldo y auditoría.

## Límite histórico

El esquema anterior a la adopción de migraciones del 29 de julio de 2026 nunca
se versionó de forma completa: el baseline original y los históricos `001`–`004`
nacieron vacíos. El replay histórico completo sigue sin ser reproducible.
Este snapshot proporciona un punto de reconstrucción verificable del estado
capturado el 21 de septiembre de 2026; **no demuestra el historial anterior**.
Las migraciones históricas permanecen intactas y no se reaplican al snapshot.

## Publicación

Con producción en `1151542`, usar mantenimiento: aplicar `20260923100000` →
`20260923110000` → `20260923120000`, verificar DB y luego publicar `8319de9`.
Si una migración falla, detener la publicación. Este procedimiento local no
realiza DB push, escrituras remotas, deploy ni commit.
