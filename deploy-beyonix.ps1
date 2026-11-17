<#
.SYNOPSIS
  Actualiza BEYONIX en producción con la versión de main ya publicada en GitHub.

.DESCRIPTION
  Ejecuta deploy/release/deploy.sh con Git Bash. El detalle de cada paso queda en
  Documentos\BEYONIX-backups\deploy-logs. Ver deploy/release/README.md.

.EXAMPLE
  .\deploy-beyonix.ps1                  # actualización completa
  .\deploy-beyonix.ps1 -SoloPreparar    # prepara y verifica la versión nueva sin activarla
  .\deploy-beyonix.ps1 -Rollback        # vuelve a la versión anterior al último despliegue
  .\deploy-beyonix.ps1 -Estado          # versión activa y resultado del último cambio (sólo lectura)
  .\deploy-beyonix.ps1 -ValidacionCompleta   # repite lint/typecheck/tests aunque el commit ya esté aprobado
  (también combinable: -SoloPreparar -ValidacionCompleta)
#>
[CmdletBinding(DefaultParameterSetName = 'Desplegar')]
param(
  [Parameter(ParameterSetName = 'Preparar')]
  [switch]$SoloPreparar,

  [Parameter(ParameterSetName = 'Desplegar')]
  [Parameter(ParameterSetName = 'Preparar')]
  [switch]$ValidacionCompleta,

  [Parameter(ParameterSetName = 'Rollback')]
  [switch]$Rollback,

  [Parameter(ParameterSetName = 'Rollback')]
  [string]$Version = '',

  [Parameter(ParameterSetName = 'Estado')]
  [switch]$Estado
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$bash = @(
  (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $bash) {
  Write-Host 'Error: no se encontró Git Bash (Git para Windows).' -ForegroundColor Red
  exit 1
}

$script = (Join-Path $PSScriptRoot 'deploy\release\deploy.sh') -replace '\\', '/'
$argumentos = @($script)
if ($SoloPreparar) { $argumentos += '--solo-preparar' }
if ($ValidacionCompleta) { $argumentos += '--validacion-completa' }
if ($Estado) { $argumentos += '--estado' }
if ($Rollback) {
  $argumentos += '--rollback'
  if ($Version) { $argumentos += $Version }
}

& $bash @argumentos
$codigo = $LASTEXITCODE
if ($codigo -eq 0) {
  Write-Host 'OK' -ForegroundColor Green
} else {
  Write-Host "Terminó con errores (código $codigo)." -ForegroundColor Red
}
exit $codigo
