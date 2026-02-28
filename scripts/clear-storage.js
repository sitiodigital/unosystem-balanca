#!/usr/bin/env node
/**
 * Remove o localStorage da aplicação Electron (configurações salvas).
 * Funciona no macOS (dev e app instalado).
 *
 * Uso: pnpm run clear-storage
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// Nomes possíveis da pasta da app (dev = name do package, instalado = productName)
const APP_NAMES = ['unosystem-balanca', 'UnoSystem'];

function getAppSupportDir() {
  if (isMac) {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (isWin) {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return path.join(os.homedir(), '.config');
}

function clearStorage() {
  const base = getAppSupportDir();
  let removed = false;

  for (const appName of APP_NAMES) {
    const localStoragePath = path.join(base, appName, 'Local Storage');
    if (fs.existsSync(localStoragePath)) {
      try {
        fs.rmSync(localStoragePath, { recursive: true });
        console.log('✅ Storage limpo:', localStoragePath);
        removed = true;
      } catch (err) {
        console.error('❌ Erro ao remover:', localStoragePath, err.message);
      }
    }
  }

  if (!removed) {
    console.log('ℹ️  Nenhuma pasta de storage encontrada.');
    console.log('   Caminhos verificados (macOS):');
    APP_NAMES.forEach((name) => {
      console.log('   -', path.join(base, name, 'Local Storage'));
    });
  } else {
    console.log('\n💡 Feche o app da balança (se estiver aberto) e abra de novo. As configurações voltarão ao padrão.');
  }
}

clearStorage();
