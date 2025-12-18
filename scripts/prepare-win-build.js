const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('📦 Preparando ambiente para build Windows...\n');

// Verificar se estamos no macOS tentando buildar para Windows
if (process.platform === 'darwin') {
  console.log('⚠️  ATENÇÃO: Você está tentando fazer build para Windows a partir do macOS.');
  console.log('⚠️  O node-gyp NÃO suporta cross-compilation de módulos nativos.\n');
  console.log('📋 O electron-builder tentará:');
  console.log('   1. Usar binários pré-compilados do npm (se disponíveis)');
  console.log('   2. Se falhar, você verá um erro sobre cross-compilation\n');
  console.log('💡 SOLUÇÕES ALTERNATIVAS:');
  console.log('   • Fazer o build em uma máquina Windows (recomendado)');
  console.log('   • Usar GitHub Actions ou CI/CD com runner Windows');
  console.log('   • Usar Docker com imagem Windows\n');
}

// Configurar variáveis de ambiente para tentar usar binários pré-compilados
process.env.npm_config_build_from_source = 'false';
process.env.ElectronRebuild_disable = 'true';

console.log('✅ Configurações aplicadas. Prosseguindo com o build...\n');
console.log('ℹ️  Se você encontrar erros de cross-compilation, consulte BUILD_WINDOWS.md\n');

