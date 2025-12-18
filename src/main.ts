import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

let mainWindow: BrowserWindow | null = null;
let webViewWindow: BrowserWindow | null = null;
let serialPort: SerialPort | null = null;
let parser: ReadlineParser | null = null;

interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: 7 | 8;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
}

function criarWebView(enderecoSistema: string) {
  if (webViewWindow) {
    webViewWindow.focus();
    return;
  }

  webViewWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  webViewWindow.loadURL(enderecoSistema);

  webViewWindow.on('closed', () => {
    webViewWindow = null;
  });
}

function fecharConexaoSerial() {
  if (parser) {
    parser.removeAllListeners();
    parser = null;
  }
  if (serialPort && serialPort.isOpen) {
    serialPort.close();
  }
  serialPort = null;
}

function abrirConexaoSerial(config: SerialConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    fecharConexaoSerial();

    serialPort = new SerialPort({
      path: config.port,
      baudRate: config.baudRate,
      dataBits: config.dataBits,
      parity: config.parity,
      stopBits: config.stopBits,
      autoOpen: false,
    });

    serialPort.open((err) => {
      if (err) {
        reject(err);
        return;
      }

      parser = serialPort!.pipe(new ReadlineParser({ delimiter: '\r\n' }));

      parser.on('data', (data: string) => {
        const peso = data.trim();
        console.log('Peso recebido:', peso);

        // Enviar peso para a janela principal
        mainWindow?.webContents.send('peso-balanca', peso);

        // Enviar peso para a WebView via JavaScript injetado
        if (webViewWindow && !webViewWindow.isDestroyed()) {
          // Criar um evento customizado na página da WebView
          const script = `
            (function() {
              // Disparar evento customizado
              window.dispatchEvent(new CustomEvent('peso-balanca', { detail: '${peso.replace(
                /'/g,
                "\\'"
              )}' }));
              
              // Também disponibilizar via função global (caso a página precise)
              if (typeof window.onPesoBalança === 'function') {
                window.onPesoBalança('${peso.replace(/'/g, "\\'")}');
              }
              
              // E via propriedade global
              window.pesoBalançaAtual = '${peso.replace(/'/g, "\\'")}';
            })();
          `;

          webViewWindow.webContents.executeJavaScript(script).catch((err) => {
            // Ignorar erros se a página ainda não estiver carregada
            console.log(
              'Erro ao injetar script na WebView (pode ser normal se a página ainda não carregou):',
              err.message
            );
          });
        }
      });

      resolve();
    });
  });
}

function lerPeso(timeout: number = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!parser) {
      reject(new Error('Conexão serial não está aberta'));
      return;
    }

    const timeoutId = setTimeout(() => {
      reject(new Error('Timeout: Nenhum dado recebido da balança'));
    }, timeout);

    const onData = (data: string) => {
      clearTimeout(timeoutId);
      parser!.removeListener('data', onData);
      resolve(data.trim());
    };

    parser.once('data', onData);
  });
}

// IPC Handlers
ipcMain.handle('listar-portas', async () => {
  try {
    const ports = await SerialPort.list();
    return ports.map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer || 'Desconhecido',
    }));
  } catch (error) {
    console.error('Erro ao listar portas:', error);
    return [];
  }
});

ipcMain.handle('testar-conexao', async (_, config: SerialConfig) => {
  try {
    await abrirConexaoSerial(config);
    const peso = await lerPeso(3000);
    fecharConexaoSerial();
    return { sucesso: true, peso };
  } catch (error: any) {
    fecharConexaoSerial();
    return {
      sucesso: false,
      erro: error.message || 'Erro desconhecido ao testar conexão',
    };
  }
});

ipcMain.handle(
  'conectar-balanca',
  async (_, config: SerialConfig, enderecoSistema: string) => {
    try {
      // Validar endereço do sistema
      if (!enderecoSistema || !enderecoSistema.startsWith('http')) {
        return {
          sucesso: false,
          erro: 'Endereço do sistema inválido. Deve começar com http:// ou https://',
        };
      }

      // Abrir conexão serial
      await abrirConexaoSerial(config);

      // Criar WebView
      criarWebView(enderecoSistema);

      return { sucesso: true };
    } catch (error: any) {
      fecharConexaoSerial();
      return {
        sucesso: false,
        erro: error.message || 'Erro ao conectar balança',
      };
    }
  }
);

app.whenReady().then(() => {
  createWindow();

  app.on('window-all-closed', () => {
    fecharConexaoSerial();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  fecharConexaoSerial();
});
