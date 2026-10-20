param([string]$Python = '')
$ErrorActionPreference = 'Stop'
$evalRoot = Split-Path -Parent $PSScriptRoot
Push-Location $evalRoot
try {
    $venvPython = Join-Path $evalRoot 'evals/.venv/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        if (-not $Python) {
            $Python = & py -3.12 -c 'import sys; print(sys.executable)'
            if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 or pass its full path with -Python' }
        }
        & $Python -m venv evals/.venv
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Python 3.12 evaluation environment' }
    }
    & $venvPython -c 'import sys; assert sys.version_info[:2] == (3, 12)'
    if ($LASTEXITCODE -ne 0) { throw 'The evaluation environment requires Python 3.12' }
    $uvCommand = Get-Command uv -ErrorAction SilentlyContinue
    $uvPath = if ($uvCommand) { $uvCommand.Source } else { Join-Path $env:USERPROFILE '.local/bin/uv.exe' }
    if (Test-Path -LiteralPath $uvPath) {
        & $uvPath pip install --python $venvPython --cache-dir data/pip-eval-cache -r evals/requirements-frameworks.windows.lock.txt
    } else {
        & $venvPython -m pip install --cache-dir data/pip-eval-cache -r evals/requirements-frameworks.windows.lock.txt
    }
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install evaluation dependencies' }
    & $venvPython -m pip check
    if ($LASTEXITCODE -ne 0) { throw 'Evaluation dependency conflict' }
    & $venvPython -c 'import evalscope, mteb, ragas'
    if ($LASTEXITCODE -ne 0) { throw 'Evaluation framework import check failed' }
    Write-Output 'Ready: npm run eval:frameworks -- --report <report.json>'
} finally { Pop-Location }
