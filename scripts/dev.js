const { spawn, exec } = require('child_process');
const chokidar = require('chokidar');
const path = require('path');

let electronProcess = null;
let isBuilding = false;
let restartTimeout = null;

function startElectron() {
  // Matar processo anterior se existir
  if (electronProcess) {
    console.log('🔄 Reiniciando Electron...');
    if (process.platform === 'win32') {
      electronProcess.kill();
    } else {
      electronProcess.kill('SIGTERM');
    }
    electronProcess = null;
  }

  // Aguardar um pouco para garantir que o build terminou
  setTimeout(() => {
    console.log('🚀 Iniciando Electron...');
    
    // No Windows, usar pnpm exec ou encontrar o executável diretamente
    // No macOS/Linux, usar npx
    const isWindows = process.platform === 'win32';
    const electronCommand = isWindows ? 'pnpm' : 'npx';
    const electronArgs = isWindows ? ['exec', 'electron', '.'] : ['electron', '.'];
    
    // No Windows, usar shell: false e passar o comando completo
    // Isso evita o warning de segurança
    const spawnOptions = {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    };
    
    if (isWindows) {
      // No Windows, usar cmd /c para executar o comando
      spawnOptions.shell = true;
    } else {
      spawnOptions.shell = false;
    }
    
    electronProcess = spawn(electronCommand, electronArgs, spawnOptions);

    electronProcess.on('close', (code) => {
      if (code !== null && code !== 0 && code !== 130) {
        console.log(`Electron encerrado com código ${code}`);
      }
      electronProcess = null;
    });

    electronProcess.on('error', (err) => {
      console.error('Erro ao iniciar Electron:', err);
      console.error('💡 Dica: Certifique-se de que o Electron está instalado: pnpm install');
    });
  }, 500);
}

function rebuildAndRestart() {
  if (isBuilding) return;
  
  isBuilding = true;
  console.log('🔄 Recompilando...');
  
  exec('pnpm build', (error, stdout, stderr) => {
    isBuilding = false;
    
    if (error) {
      console.error('❌ Erro ao compilar:', error.message);
      return;
    }
    
    if (stdout) {
      console.log(stdout.trim());
    }
    
    if (stderr && !stderr.includes('warning')) {
      console.error(stderr);
    }
    
    startElectron();
  });
}

// Fazer build inicial
console.log('🚀 Iniciando modo desenvolvimento...');
rebuildAndRestart();

// Monitorar mudanças nos arquivos fonte
const srcDir = path.join(__dirname, '../src');
const watcher = chokidar.watch(srcDir, {
  ignored: /(^|[\/\\])\../, // ignorar arquivos ocultos
  persistent: true,
  ignoreInitial: true,
});

watcher.on('change', (filePath) => {
  const ext = path.extname(filePath);
  if (['.ts', '.html', '.css'].includes(ext)) {
    console.log(`📝 Arquivo alterado: ${path.relative(srcDir, filePath)}`);
    
    // Debounce para evitar múltiplas compilações
    if (restartTimeout) {
      clearTimeout(restartTimeout);
    }
    
    restartTimeout = setTimeout(() => {
      rebuildAndRestart();
    }, 300);
  }
});

watcher.on('error', (error) => {
  console.error('Erro no watcher:', error);
});

// Tratar encerramento
function cleanup() {
  console.log('\n👋 Encerrando...');
  watcher.close();
  if (electronProcess) {
    if (process.platform === 'win32') {
      electronProcess.kill();
    } else {
      electronProcess.kill('SIGTERM');
    }
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// No Windows, também tratar Ctrl+C via eventos diferentes
if (process.platform === 'win32') {
  process.on('SIGBREAK', cleanup);
  process.on('exit', () => {
    if (electronProcess) {
      electronProcess.kill();
    }
  });
}

