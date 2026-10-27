param(
    [string]$Branch = 'main',
    [string]$DenyListPath = 'work/push-denylist.txt',
    [string]$MessageDenyListPath = 'work/push-message-denylist.txt'
)

$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel).Trim()
if (-not $repoRoot) {
    throw '当前目录不在 Git 仓库中'
}
Push-Location $repoRoot

$failures = [System.Collections.Generic.List[string]]::new()

function Add-Failure([string]$message) {
    $failures.Add($message)
}

$currentBranch = (git branch --show-current).Trim()
if ($currentBranch -ne $Branch) {
    Add-Failure "当前分支为 '$currentBranch'，预期为 '$Branch'"
}

$status = @(git status --porcelain=v1 -uall)
if ($status.Count -gt 0) {
    Add-Failure '工作区不干净，存在未提交或未跟踪文件'
}

$expectedName = 'muhan5102'
$expectedEmailSuffix = '@users.noreply.github.com'
$gitName = (git config user.name).Trim()
$gitEmail = (git config user.email).Trim()
$signing = (git config commit.gpgsign).Trim()
if ($gitName -ne $expectedName) {
    Add-Failure "Git 作者名称不符合仓库约定：$gitName"
}
if (-not $gitEmail.EndsWith($expectedEmailSuffix, [System.StringComparison]::OrdinalIgnoreCase)) {
    Add-Failure 'Git 邮箱不是 GitHub noreply 地址'
}
if ($signing -ne 'true') {
    Add-Failure '当前仓库未启用提交签名'
}

$denyPath = Join-Path $repoRoot $DenyListPath
if (-not (Test-Path -LiteralPath $denyPath -PathType Leaf)) {
    Add-Failure "缺少本地受限词清单：$DenyListPath"
}

$denyTerms = @()
if (Test-Path -LiteralPath $denyPath -PathType Leaf) {
    $denyTerms = Get-Content -LiteralPath $denyPath -Encoding UTF8 |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith('#') }
}

$messageDenyPath = Join-Path $repoRoot $MessageDenyListPath
if (-not (Test-Path -LiteralPath $messageDenyPath -PathType Leaf)) {
    Add-Failure "缺少本地提交信息禁词清单：$MessageDenyListPath"
}
$messageDenyTerms = @()
if (Test-Path -LiteralPath $messageDenyPath -PathType Leaf) {
    $messageDenyTerms = Get-Content -LiteralPath $messageDenyPath -Encoding UTF8 |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith('#') }
}

$textFilePattern = '\.(md|txt|json|ya?ml|js|mjs|ts|py|sh|ps1|bat|cmd|diff|gitignore)$'
$commits = @(git rev-list HEAD)
$trackedFiles = @(git -c core.quotepath=false ls-files)
$secretPatterns = @(
    '-----BEGIN [A-Z ]*PRIVATE KEY',
    'sk-[A-Za-z0-9_-]{10,}',
    'gh[pousr]_[A-Za-z0-9]{20,}',
    'xox[baprs]-[A-Za-z0-9-]{10,}',
    'AIza[0-9A-Za-z_-]{35}',
    'bn_live_[A-Za-z0-9_-]+',
    '[A-Za-z]:\\Users\\[^\\]+',
    '(?:group|private):\d{5,}'
)

foreach ($file in $trackedFiles) {
    foreach ($term in $denyTerms) {
        if ($file.IndexOf($term, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Add-Failure "当前文件名命中受限词：$file"
        }
    }
    if ($file -notmatch $textFilePattern -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        continue
    }
    foreach ($term in $denyTerms) {
        $match = Select-String -LiteralPath $file -Pattern $term -SimpleMatch -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($match) {
            Add-Failure "当前文件命中受限词：$file`:$($match.LineNumber)"
        }
    }
}

foreach ($commit in $commits) {
    $message = git show -s --format='%B' $commit
    $messageTerms = @($denyTerms + $messageDenyTerms | Select-Object -Unique)
    foreach ($term in $messageTerms) {
        if (($message | Select-String -Pattern $term -SimpleMatch).Count -gt 0) {
            Add-Failure "提交信息命中受限词：$($commit.Substring(0, 7))"
        }
    }

    $body = git cat-file commit $commit
    if (($body | Select-String -SimpleMatch 'BEGIN SSH SIGNATURE').Count -eq 0) {
        Add-Failure "提交缺少 SSH 签名：$($commit.Substring(0, 7))"
    }

    foreach ($file in (git -c core.quotepath=false ls-tree -r --name-only $commit)) {
        foreach ($term in $denyTerms) {
            if ($file.IndexOf($term, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Add-Failure "历史文件名命中受限词：$($commit.Substring(0, 7)) $file"
            }
        }
        if ($file -notmatch $textFilePattern) {
            continue
        }
        $content = git -c core.quotepath=false show "${commit}:$file" 2>$null
        foreach ($term in $denyTerms) {
            if (($content | Select-String -Pattern $term -SimpleMatch).Count -gt 0) {
                Add-Failure "历史内容命中受限词：$($commit.Substring(0, 7)) $file"
            }
        }
        foreach ($pattern in $secretPatterns) {
            if (($content | Select-String -Pattern $pattern).Count -gt 0) {
                Add-Failure "历史内容命中高风险模式：$($commit.Substring(0, 7)) $file"
            }
        }
    }
}

foreach ($file in $trackedFiles) {
    if ($file -notmatch $textFilePattern -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        continue
    }
    foreach ($pattern in $secretPatterns) {
        $match = Select-String -LiteralPath $file -Pattern $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($match) {
            Add-Failure "当前文件命中高风险模式：$file`:$($match.LineNumber)"
        }
    }
}

$remoteMain = ''
try {
    $remoteMain = (git rev-parse 'origin/main' 2>$null).Trim()
} catch {
    $remoteMain = ''
}
if (-not $remoteMain) {
    Add-Failure '无法读取 origin/main，先执行 git fetch origin main'
}

$forceRequired = $false
if ($remoteMain) {
    git merge-base --is-ancestor 'origin/main' HEAD *> $null
    $forceRequired = ($LASTEXITCODE -ne 0)
}

if ($failures.Count -gt 0) {
    'PUSH_PREFLIGHT=FAIL'
    $failures | ForEach-Object { "- $_" }
    Pop-Location
    exit 1
}

'PUSH_PREFLIGHT=PASS'
"BRANCH=$currentBranch"
"HEAD=$((git rev-parse HEAD).Trim())"
"ORIGIN_MAIN=$remoteMain"
"FORCE_WITH_LEASE_REQUIRED=$($forceRequired.ToString().ToLowerInvariant())"
Pop-Location
exit 0

