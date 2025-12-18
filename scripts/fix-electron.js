const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo instalação do Electron...\n');

const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
const electronPath = path.join(nodeModulesPath, '.pnpm', 'electron@39.2.7');

console.log('📦 Reinstalando Electron...\n');

try {
  // Remover cache do pnpm relacionado ao Electron
  console.log('1. Limpando cache do Electron...');
  
  // Reinstalar apenas o Electron
  console.log('2. Reinstalando Electron...');
  execSync('pnpm remove electron', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  execSync('pnpm add -D electron@^39.2.7', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  
  console.log('\n✅ Electron reinstalado com sucesso!');
  console.log('💡 Agora você pode executar: pnpm run dev\n');
} catch (error) {
  console.error('\n❌ Erro ao reinstalar Electron:', error.message);
  console.log('\n💡 Tente executar manualmente:');
  console.log('   pnpm remove electron');
  console.log('   pnpm add -D electron@^39.2.7');
  process.exit(1);
}

