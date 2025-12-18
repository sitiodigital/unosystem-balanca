const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo instalação do Electron...\n');

const isWindows = process.platform === 'win32';
const projectRoot = path.join(__dirname, '..');

function checkElectronInstalled() {
  try {
    // Tentar carregar o Electron para verificar se está instalado corretamente
    const electronPath = path.join(projectRoot, 'node_modules', '.pnpm', 'electron@39.2.7', 'node_modules', 'electron');
    const electronIndex = path.join(electronPath, 'index.js');
    
    if (!fs.existsSync(electronIndex)) {
      return false;
    }
    
    // Tentar executar o script de instalação do Electron
    const electronInstall = path.join(electronPath, 'install.js');
    if (fs.existsSync(electronInstall)) {
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

console.log('📦 Verificando instalação do Electron...\n');

if (!checkElectronInstalled()) {
  console.log('⚠️  Electron não está instalado corretamente.\n');
  console.log('📥 Reinstalando Electron...\n');
  
  try {
    // Remover Electron
    console.log('1. Removendo Electron...');
    try {
      execSync('pnpm remove electron', { 
        stdio: 'inherit', 
        cwd: projectRoot,
        shell: isWindows 
      });
    } catch (e) {
      // Ignorar erro se não existir
    }
    
    // Limpar cache do pnpm
    console.log('2. Limpando cache...');
    try {
      execSync('pnpm store prune', { 
        stdio: 'inherit',
        shell: isWindows 
      });
    } catch (e) {
      // Ignorar erro
    }
    
    // Reinstalar Electron com postinstall
    console.log('3. Reinstalando Electron (isso pode demorar alguns minutos)...');
    execSync('pnpm add -D electron@^39.2.7', { 
      stdio: 'inherit', 
      cwd: projectRoot,
      shell: isWindows,
      env: {
        ...process.env,
        npm_config_cache: undefined, // Forçar download novo
      }
    });
    
    console.log('\n✅ Electron reinstalado com sucesso!');
    console.log('💡 Agora você pode executar: pnpm run dev\n');
  } catch (error) {
    console.error('\n❌ Erro ao reinstalar Electron:', error.message);
    console.log('\n💡 SOLUÇÃO MANUAL:');
    console.log('   1. Delete a pasta node_modules');
    console.log('   2. Execute: pnpm install');
    console.log('   3. Se ainda não funcionar, execute: pnpm store prune && pnpm install');
    process.exit(1);
  }
} else {
  console.log('✅ Electron parece estar instalado corretamente.');
  console.log('💡 Se ainda tiver problemas, tente: pnpm store prune && pnpm install\n');
}

