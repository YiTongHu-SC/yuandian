[CmdletBinding()]
param(
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolRoot = $PSScriptRoot
$toolPort = 4176
$toolUrl = 'http://127.0.0.1:4176/'
$markerPattern = '<meta\b(?=[^>]*\bname\s*=\s*["'']application-name["''])(?=[^>]*\bcontent\s*=\s*["'']first-principles-workbench["''])[^>]*>'

function Test-LocalPort {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.ConnectAsync('127.0.0.1', $toolPort)
        if (-not $connection.Wait(750)) { return $false }
        return $client.Connected
    }
    catch { return $false }
    finally { $client.Dispose() }
}

function Test-WorkbenchServer {
    try {
        $response = Invoke-WebRequest -Uri ($toolUrl + 'index.html') -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return ($response.StatusCode -eq 200 -and $response.Content -match $markerPattern -and $response.Content -match '<meta\s+name="thinking-canvas-project"\s+content="standalone"')
    }
    catch { return $false }
}

function Find-Python {
    $candidates = @('C:/Users/huyit/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')
    $pythonCommand = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pythonCommand) { $candidates += $pythonCommand.Source }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $versionText = (& $candidate --version 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $versionText -match '^Python 3\.(\d+)\.' -and [int]$Matches[1] -ge 7) {
                return $candidate
            }
        }
        catch { continue }
    }
    throw '没有找到可用的 Python 3.7 或以上版本。请安装 Python 并确保 python 命令可用，然后重试。'
}

try {
    if (Test-LocalPort) {
        if (-not (Test-WorkbenchServer)) {
            throw '127.0.0.1:4176 已被其他服务占用，或当前服务无法确认是本工具。未停止任何进程。请检查该端口的服务，释放端口后重试。'
        }
        Write-Host ('已复用本工具的本地服务：' + $toolUrl)
    }
    else {
        foreach ($name in @('index.html', 'canvas.js', 'canvas.css', 'canvas-model.js', 'guided.html', 'app.js', 'styles.css', 'model.js', 'logic.js')) {
            if (-not (Test-Path -LiteralPath (Join-Path $toolRoot $name) -PathType Leaf)) {
                throw ('工具文件不完整，缺少：' + $name + '。请恢复本目录的完整文件后重试。')
            }
        }
        $indexText = Get-Content -LiteralPath (Join-Path $toolRoot 'index.html') -Raw -Encoding UTF8
        if ($indexText -notmatch $markerPattern) {
            throw 'index.html 缺少本工具标记，无法安全确认启动目标。请恢复完整的工具文件。'
        }
        $pythonPath = Find-Python
        $logName = 'first-principles-' + [guid]::NewGuid().ToString('N')
        $errorLog = Join-Path ([System.IO.Path]::GetTempPath()) ($logName + '.stderr.log')
        $outputLog = Join-Path ([System.IO.Path]::GetTempPath()) ($logName + '.stdout.log')
        $arguments = @('-m', 'http.server', [string]$toolPort, '--bind', '127.0.0.1', '--directory', ('"' + $toolRoot + '"'))
        $server = Start-Process -FilePath $pythonPath -ArgumentList $arguments -WorkingDirectory $toolRoot -WindowStyle Hidden -RedirectStandardError $errorLog -RedirectStandardOutput $outputLog -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (Test-WorkbenchServer) { $ready = $true; break }
            if ($server.HasExited) { break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) {
            throw ('本地服务未通过工具标记检查。可能存在端口冲突或启动异常；未停止任何进程。诊断日志：' + $errorLog)
        }
        Write-Host ('已启动本地服务：' + $toolUrl)
        Write-Host ('Python 进程 PID：' + $server.Id + '；关闭页面不会停止本地服务，再运行脚本可复用。')
    }
    if (-not $NoBrowser) { Start-Process -FilePath $toolUrl | Out-Null }
}
catch {
    Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
