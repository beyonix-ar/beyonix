# RESET TOTAL DE DATOS DE VENTA DE PRUEBA. Ejecutar desde cualquier carpeta.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repoRoot 'node_modules/.bin/supabase.cmd'
$projectRef = (Get-Content -LiteralPath (Join-Path $repoRoot 'supabase/.temp/project-ref') -Raw).Trim()
$resetSql = Join-Path $repoRoot 'supabase/maintenance/reset_customer_test_sales.sql'

if (-not (Test-Path -LiteralPath $cli) -or -not (Test-Path -LiteralPath $resetSql) -or -not $projectRef) {
  throw 'Falta Supabase CLI, el proyecto vinculado o el SQL de reset.'
}

# La CLI no puede leer .env.local (contiene claves multilínea); la consulta
# vinculada usa la sesión de Supabase CLI y se lanza desde el directorio padre.
Push-Location (Split-Path -Parent $repoRoot)
try {
  & $cli db query --linked --project-ref $projectRef --file $resetSql
  if ($LASTEXITCODE -ne 0) { throw 'El reset falló; la transacción SQL fue revertida.' }
  & $cli db query --linked --project-ref $projectRef "select (select count(*) from public.ordenes) pedidos, (select count(*) from public.orden_items) items, (select count(*) from public.order_claims) reclamos, (select count(*) from public.mercadopago_order_refunds) reintegros, (select count(*) from public.dispatch_batches) bultos, (select count(*) from public.order_preparation_lines) picking, (select count(*) from public.stock_reservations where order_id is not null) reservas, (select count(*) from public.product_cost_entries) compras_proveedor"
  if ($LASTEXITCODE -ne 0) { throw 'El reset se aplicó, pero falló la consulta de verificación.' }
} finally {
  Pop-Location
}
