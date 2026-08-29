<#
release.ps1 — dsh-file-attachment 统一发布流程
  默认（patch）：bump 版本 → 提交 → 推两个 remote（gitea + origin/GitHub）→ npm publish
用法：
  .\release.ps1                                              # patch 版本，完整发布
  .\release.ps1 -Bump minor                                  # minor / major 同理
  .\release.ps1 -Bump none -SkipPublish -Message "chore: x"  # 仅提交 + 推两个 remote，不 bump/不发布
参数：
  -Bump         none | patch | minor | major（默认 patch）
  -Message      提交信息（默认 "release vX.Y.Z"）
  -SkipPublish  跳过 npm publish
#>
[CmdletBinding()]
param(
  [ValidateSet('none', 'patch', 'minor', 'major')][string]$Bump = 'patch',
  [string]$Message = '',
  [switch]$SkipPublish
)

$ErrorActionPreference = 'Stop'
Set-Location -NoProfile -Path $PSScriptRoot

# 1) 可选 bump 版本号（仅改 package.json，不建 git tag；本项目无 lock 文件）
if ($Bump -ne 'none') {
  npm version $Bump --no-git-tag-version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm version $Bump 失败" }
}

# 2) 暂存全部并提交
git add -A
if (git diff --cached --quiet) {
  Write-Host "无变更可提交，退出。" -ForegroundColor Yellow
  return
}
if ([string]::IsNullOrWhiteSpace($Message)) {
  $Message = 'release ' + (Get-Content package.json -Raw | ConvertFrom-Json).version
}
git commit -m $Message | Out-Null
if ($LASTEXITCODE -ne 0) { throw "git commit 失败" }

# 3) 推两个 remote（gitea + origin/GitHub）
git push gitea master | Out-Null
if ($LASTEXITCODE -ne 0) { throw "git push gitea 失败" }
git push origin master | Out-Null
if ($LASTEXITCODE -ne 0) { throw "git push origin(GitHub) 失败" }
Write-Host "已推送 gitea + origin(GitHub)。" -ForegroundColor Green

# 4) 发布 npm
if ($SkipPublish) {
  Write-Host "已跳过 npm publish（-SkipPublish）。" -ForegroundColor Yellow
  return
}
npm publish
if ($LASTEXITCODE -ne 0) { throw "npm publish 失败" }
Write-Host ("发布完成：" + (Get-Content package.json -Raw | ConvertFrom-Json).version) -ForegroundColor Green
