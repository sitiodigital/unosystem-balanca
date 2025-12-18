# Script PowerShell para corrigir instalação do Electron no Windows

Write-Host "Corrigindo instalacao do Electron no Windows..." -ForegroundColor Cyan
Write-Host ""

# Verificar se está no diretório correto
if (-not (Test-Path "package.json")) {
    Write-Host "Erro: Execute este script na raiz do projeto" -ForegroundColor Red
    exit 1
}

Write-Host "Passo 1: Removendo node_modules..." -ForegroundColor Yellow
if (Test-Path "node_modules") {
    Remove-Item -Recurse -Force "node_modules" -ErrorAction SilentlyContinue
    Write-Host "node_modules removido" -ForegroundColor Green
} else {
    Write-Host "node_modules nao existe" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Passo 2: Removendo pnpm-lock.yaml..." -ForegroundColor Yellow
if (Test-Path "pnpm-lock.yaml") {
    Remove-Item -Force "pnpm-lock.yaml" -ErrorAction SilentlyContinue
    Write-Host "pnpm-lock.yaml removido" -ForegroundColor Green
} else {
    Write-Host "pnpm-lock.yaml nao existe" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Passo 3: Limpando cache do pnpm..." -ForegroundColor Yellow
pnpm store prune
Write-Host "Cache limpo" -ForegroundColor Green

Write-Host ""
Write-Host "Passo 4: Reinstalando dependencias (isso pode demorar alguns minutos)..." -ForegroundColor Yellow
Write-Host "   Aguarde enquanto o Electron baixa os binarios..." -ForegroundColor Gray
pnpm install

Write-Host ""
Write-Host "Passo 5: Verificando instalacao do Electron..." -ForegroundColor Yellow
$electronVersion = pnpm exec electron --version 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "Electron instalado corretamente! Versao: $electronVersion" -ForegroundColor Green
    Write-Host ""
    Write-Host "Agora voce pode executar: pnpm run dev" -ForegroundColor Cyan
} else {
    Write-Host "Electron ainda nao esta funcionando" -ForegroundColor Red
    Write-Host ""
    Write-Host "Tente executar manualmente:" -ForegroundColor Yellow
    Write-Host "   pnpm remove electron" -ForegroundColor Gray
    Write-Host "   pnpm add -D electron@^39.2.7 --force" -ForegroundColor Gray
    exit 1
}
