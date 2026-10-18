[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [ValidateRange(1, 65535)]
    [int]$Port = 4176
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/')
$toolUrl = 'http://127.0.0.1:' + $Port + '/'
$identityUrl = $toolUrl + '__thinking_canvas_server__'

function Test-SameDirectory([string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
    try {
        $candidatePath = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
        return [string]::Equals($candidatePath, $toolRoot, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Test-LocalPort {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $connection.Wait(750)) { return $false }
        return $client.Connected
    }
    catch { return $false }
    finally { $client.Dispose() }
}

function Test-NodeServer {
    try {
        $response = Invoke-WebRequest -Uri $identityUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        $identity = $response.Content | ConvertFrom-Json
        return ($identity.application -eq 'yuandian-thinking-canvas' -and $identity.protocol -eq 1 -and (Test-SameDirectory $identity.root))
    }
    catch { return $false }
}

function Test-LegacyPythonServer {
    try {
        $response = Invoke-WebRequest -Uri ($toolUrl + 'index.html') -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($response.Content -notmatch '<meta\s+name="thinking-canvas-project"\s+content="standalone"') { return $false }
        # A page marker alone cannot distinguish another checkout. Verify the listening process and its --directory.
        $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
        if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') { return $false }
        $listenerProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listeners[0].OwningProcess) -ErrorAction Stop
        $commandLine = [string]$listenerProcess.CommandLine
        if ($commandLine -notmatch '(?:^|\s)-m\s+http\.server(?:\s|$)' -or $commandLine -notmatch '(?:^|\s)--bind(?:=|\s+)"?127\.0\.0\.1"?(?:\s|$)') { return $false }
        $directoryMatch = [regex]::Match($commandLine, '(?:^|\s)--directory(?:=|\s+)(?:"([^"]+)"|''([^'']+)''|(\S+))')
        if (-not $directoryMatch.Success) { return $false }
        foreach ($groupIndex in @(1, 2, 3)) {
            if ($directoryMatch.Groups[$groupIndex].Success) { return Test-SameDirectory $directoryMatch.Groups[$groupIndex].Value }
        }
        return $false
    }
    catch { return $false }
}

function Find-Node {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $nodeCommand) {
        $versionText = (& $nodeCommand.Source --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $versionText -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20) { return $nodeCommand.Source }
    }
    throw '没有找到 Node.js 20 或以上版本。请安装 Node.js 并确保 node 命令在 PATH 中可用，然后重试。'
}

try {
    if (Test-LocalPort) {
        if (Test-NodeServer) {
            Write-Host ('已复用同目录的本地服务：' + $toolUrl)
        }
        elseif (Test-LegacyPythonServer) {
            Write-Host ('已复用同目录的旧 Python 服务：' + $toolUrl)
            Write-Host '该旧服务未限制公开文件范围。切换到新版服务需自行关闭旧进程后再启动；当前未停止任何进程。'
        }
        else {
            throw ('127.0.0.1:' + $Port + ' 已被其他服务占用，或无法确认属于当前目录。未停止任何进程，请检查占用后重试。')
        }
    }
    else {
        $serverScript = Join-Path $toolRoot 'scripts/dev-server.mjs'
        if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) { throw '缺少 scripts/dev-server.mjs，请恢复完整项目后重试。' }
        $nodePath = Find-Node
        $logName = 'thinking-canvas-' + [guid]::NewGuid().ToString('N')
        $errorLog = Join-Path ([System.IO.Path]::GetTempPath()) ($logName + '.stderr.log')
        $outputLog = Join-Path ([System.IO.Path]::GetTempPath()) ($logName + '.stdout.log')
        $arguments = @(('"' + $serverScript + '"'), '--port', [string]$Port)
        $server = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $toolRoot -WindowStyle Hidden -RedirectStandardError $errorLog -RedirectStandardOutput $outputLog -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (Test-NodeServer) { $ready = $true; break }
            if ($server.HasExited) { break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) {
            throw ('本地服务未通过当前目录检查。未停止任何进程；诊断日志：' + $errorLog)
        }
        Write-Host ('已启动本地服务：' + $toolUrl)
        Write-Host ('Node.js 进程 PID：' + $server.Id + '；关闭页面不会停止服务，再运行脚本可复用。')
    }
    if (-not $NoBrowser) { Start-Process -FilePath $toolUrl | Out-Null }
}
catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
