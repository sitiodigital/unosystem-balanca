const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔧 Forçando instalação dos binários do Electron...\n');

const isWindows = process.platform === 'win32';
const projectRoot = path.join(__dirname, '..');
const electronPath = path.join(projectRoot, 'node_modules', '.pnpm', 'electron@39.2.7', 'node_modules', 'electron');
const installScript = path.join(electronPath, 'install.js');

console.log('📦 Verificando instalação do Electron...\n');

if (!fs.existsSync(electronPath)) {
  console.log('❌ Electron não encontrado. Execute: pnpm install\n');
  process.exit(1);
}

if (!fs.existsSync(installScript)) {
  console.log('❌ Script de instalação não encontrado.');
  console.log('💡 Tente reinstalar: pnpm remove electron && pnpm add -D electron@^39.2.7\n');
  process.exit(1);
}

console.log('✅ Electron encontrado.');
console.log('📥 Executando script de instalação para baixar binários...\n');

try {
  // Executar o script de instalação do Electron
  execSync(`node "${installScript}"`, {
    stdio: 'inherit',
    cwd: electronPath,
    shell: isWindows,
    env: {
      ...process.env,
      // Forçar download mesmo se já existir
      ELECTRON_SKIP_BINARY_DOWNLOAD: undefined,
    }
  });
  
  console.log('\n✅ Binários do Electron instalados com sucesso!');
  console.log('💡 Teste com: pnpm exec electron --version\n');
} catch (error) {
  console.error('\n❌ Erro ao instalar binários do Electron:', error.message);
  console.log('\n💡 SOLUÇÃO ALTERNATIVA:');
  console.log('   1. Delete: node_modules\\.pnpm\\electron@39.2.7');
  console.log('   2. Execute: pnpm install --force');
  console.log('   3. Aguarde o download completo dos binários');
  process.exit(1);
}

