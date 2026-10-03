<#
.SYNOPSIS
  通过 SSH 隧道访问服务器上的机器人控制台与 SnowLuma 面板。

.DESCRIPTION
  把服务器上只监听本机（或原本对公网开放）的 3210 / 5099 端口转发到本机回环地址，
  这样控制台与面板不必对公网开放。需要本机有可用的 SSH 私钥。

  本脚本不改动服务器配置，也不修改本机系统代理设置；按 Ctrl+C 结束时隧道随之关闭。

.EXAMPLE
  .\console-tunnel.ps1 -ServerHost <SERVER_IP>
#>
param(
  [Parameter(Mandatory = $true)][string]$ServerHost,
  [string]$User = "admin",
  [string]$KeyPath = (Join-Path $env:USERPROFILE ".ssh\qqbot_deploy"),
  [int]$ConsolePort = 3210,
  [int]$PanelPort = 5099,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $KeyPath)) {
  throw "找不到 SSH 私钥：$KeyPath（可用 -KeyPath 指定）"
}

$target = "$User@$ServerHost"
$sshBase = @("-i", $KeyPath, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12")

Write-Host "读取控制台 token ..."
$token = (& ssh @sshBase $target "cd /mnt/data/qq-agent/app && bash manage.sh token" 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) {
  throw "读取 token 失败：$token"
}
$token = $token.Trim()
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "没有取到 token，请确认服务器上的服务状态。"
}

$forwardArgs = @(
  "-N",
  "-o", "ExitOnForwardFailure=yes",
  "-L", "$ConsolePort`:127.0.0.1:$ConsolePort",
  "-L", "$PanelPort`:127.0.0.1:$PanelPort"
)

Write-Host "建立隧道 -> 控制台 127.0.0.1:$ConsolePort ，面板 127.0.0.1:$PanelPort"
$proc = Start-Process -FilePath "ssh" -ArgumentList ($sshBase + $forwardArgs + @($target)) -PassThru -WindowStyle Hidden

Start-Sleep -Seconds 2
if ($proc.HasExited) {
  throw "隧道未能建立（ssh 已退出，退出码 $($proc.ExitCode)）。请确认服务器可达且 22 端口开放。"
}

Write-Host ""
Write-Host "控制台地址：http://127.0.0.1:$ConsolePort"
Write-Host "控制台 token：$token"
Write-Host "面板地址：  http://127.0.0.1:$PanelPort"
Write-Host ""
Write-Host "按 Ctrl+C 结束并关闭隧道。"

if (-not $NoBrowser) {
  Start-Process "http://127.0.0.1:$ConsolePort"
}

try {
  Wait-Process -Id $proc.Id
}
finally {
  if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
  }
  Write-Host "隧道已关闭。"
}
