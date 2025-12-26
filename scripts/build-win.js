const { spawn, execSync } = require('child_process');
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
} else if (process.platform === 'win32') {
  console.log('✅ Detectado Windows. Build nativo será executado.\n');
}

// Configurar variáveis de ambiente
const env = {
  ...process.env,
  npm_config_build_from_source: 'false',
  ElectronRebuild_disable: 'true',
};

// Converter PNG para ICO antes do build
console.log('🔄 Convertendo ícone PNG para ICO...\n');
try {
  execSync('node scripts/convert-icon.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
} catch (error) {
  console.error('❌ Erro ao converter ícone:', error.message);
  process.exit(1);
}

console.log('✅ Configurações aplicadas. Executando electron-builder...\n');

// Executar electron-builder com as variáveis de ambiente configuradas
// Usar shell: false no Windows para evitar o warning de segurança
const electronBuilder = spawn('electron-builder', ['--win', '--x64'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: env,
  cwd: path.join(__dirname, '..'),
});

electronBuilder.on('close', (code) => {
  process.exit(code || 0);
});

electronBuilder.on('error', (err) => {
  console.error('❌ Erro ao executar electron-builder:', err);
  process.exit(1);
});

