<#
  Termina el árbol de procesos de una ejecución (p. ej. `npm test` que superó su tiempo) sin tocar
  procesos ajenos. Usado por deploy/release/lib.sh.

  -Snapshot: sólo registra en -KnownFile los descendientes actuales (pid + hora de creación).
             Se llama periódicamente para no perder procesos cuyo padre ya terminó (huérfanos).
  Sin -Snapshot: escalada (cierre normal -> espera -> forzado) sobre el árbol actual más los
             procesos registrados que sigan vivos con la MISMA hora de creación (evita matar
             un proceso ajeno que reutilizó el PID). Termina con "restantes=N"; exit 1 si N > 0.
#>
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [string]$KnownFile = '',
  [int]$GraceSeconds = 10,
  [switch]$Snapshot
)
$ErrorActionPreference = 'Stop'

function Get-ProcessTable {
  Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{
      Pid    = [int]$_.ProcessId
      Parent = [int]$_.ParentProcessId
      Ticks  = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
      Name   = $_.Name
    }
  }
}

# Descendientes de RootPid: un hijo cuenta sólo si se creó después que su padre (PID reutilizado = ajeno).
function Get-Tree($table, [int]$rootPid) {
  $byPid = @{}
  foreach ($p in $table) { $byPid[$p.Pid] = $p }
  $result = @()
  if (-not $byPid.ContainsKey($rootPid)) { return $result }
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($byPid[$rootPid])
  $seen = @{}
  while ($queue.Count -gt 0) {
    $node = $queue.Dequeue()
    if ($seen.ContainsKey($node.Pid)) { continue }
    $seen[$node.Pid] = $true
    $result += $node
    foreach ($child in ($table | Where-Object { $_.Parent -eq $node.Pid -and $_.Ticks -ge $node.Ticks })) {
      $queue.Enqueue($child)
    }
  }
  return $result
}

function Read-Known {
  $known = @()
  if ($KnownFile -and (Test-Path $KnownFile)) {
    foreach ($line in Get-Content $KnownFile) {
      $parts = $line -split ' '
      if ($parts.Count -eq 2) { $known += [pscustomobject]@{ Pid = [int]$parts[0]; Ticks = [long]$parts[1] } }
    }
  }
  return $known
}

function Get-Alive($targets) {
  $table = Get-ProcessTable
  $now = @{}
  foreach ($p in $table) { $now["$($p.Pid):$($p.Ticks)"] = $p }
  return @($targets | Where-Object { $now.ContainsKey("$($_.Pid):$($_.Ticks)") })
}

$table = Get-ProcessTable
$tree = Get-Tree $table $RootPid

if ($Snapshot) {
  if ($KnownFile) {
    $tree | ForEach-Object { "$($_.Pid) $($_.Ticks)" } | Add-Content -Path $KnownFile -Encoding ascii
  }
  exit 0
}

$targets = @{}
foreach ($p in $tree) { $targets["$($p.Pid):$($p.Ticks)"] = $p }
foreach ($k in Read-Known) { $targets["$($k.Pid):$($k.Ticks)"] = $k }
$targets = @($targets.Values)
$self = $PID
$targets = @($targets | Where-Object { $_.Pid -ne $self })

$alive = Get-Alive $targets
Write-Output "objetivos=$($alive.Count)"

# 1) Cierre normal (los procesos de consola suelen ignorarlo; su error no debe cortar la escalada).
foreach ($p in $alive) { & cmd.exe /c "taskkill /PID $($p.Pid) >nul 2>&1" }
$deadline = (Get-Date).AddSeconds($GraceSeconds)
while ((Get-Date) -lt $deadline -and (Get-Alive $targets).Count -gt 0) { Start-Sleep -Milliseconds 500 }

# 2) Forzado de lo que quede.
foreach ($p in (Get-Alive $targets)) {
  try { Stop-Process -Id $p.Pid -Force -ErrorAction Stop } catch { }
}
Start-Sleep -Seconds 1

# 3) Comprobación final.
$remaining = Get-Alive $targets
Write-Output "restantes=$($remaining.Count)"
if ($remaining.Count -gt 0) {
  $remaining | ForEach-Object { Write-Output "sigue_vivo pid=$($_.Pid)" }
  exit 1
}
exit 0
