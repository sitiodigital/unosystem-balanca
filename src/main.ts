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

    console.log('Abrindo conexão serial com configuração:', config);

    serialPort = new SerialPort({
      path: config.port,
      baudRate: config.baudRate,
      dataBits: config.dataBits,
      parity: config.parity,
      stopBits: config.stopBits,
      autoOpen: false,
    });

    // Listener para dados brutos (para debug)
    serialPort.on('data', (data: Buffer) => {
      console.log(
        'Dados brutos recebidos:',
        data.toString('hex'),
        '| Texto:',
        data.toString()
      );
    });

    serialPort.on('error', (err) => {
      console.error('Erro na porta serial:', err);
    });

    serialPort.open((err) => {
      if (err) {
        console.error('Erro ao abrir porta serial:', err);
        reject(err);
        return;
      }

      console.log('Porta serial aberta com sucesso');

      // Toledo usa CR (\r) como delimitador no protocolo TOLEDO Continuous
      // Formato: STX ... dados ... CR CHK
      parser = serialPort!.pipe(new ReadlineParser({ delimiter: '\r' }));

      parser.on('data', (data: string) => {
        const peso = data.trim();
        console.log('Peso recebido (parser):', peso);

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

      // Pequeno delay para garantir que a conexão está estável
      setTimeout(() => {
        resolve();
      }, 100);
    });
  });
}

function enviarComando(comando: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!serialPort || !serialPort.isOpen) {
      reject(new Error('Conexão serial não está aberta'));
      return;
    }

    const buffer = Buffer.isBuffer(comando)
      ? comando
      : Buffer.from(comando, 'utf8');
    console.log(
      'Enviando comando para balança:',
      buffer.toString('hex'),
      '| Texto:',
      buffer.toString()
    );

    serialPort.write(buffer, (err) => {
      if (err) {
        console.error('Erro ao enviar comando:', err);
        reject(err);
      } else {
        console.log('Comando enviado com sucesso');
        resolve();
      }
    });
  });
}

// Função para processar resposta no formato Toledo
// Formato: STX SWA SWB SWC MSD ... LSD CR CHK
function processarRespostaToledo(data: string): string {
  // Remover caracteres de controle (STX = 0x02, ETX = 0x03)
  let resposta = data.replace(/[\x02\x03]/g, '').trim();

  // Se a resposta contém dados estruturados, tentar extrair o peso
  // O formato Toledo geralmente tem o peso nos dígitos MSD-LSD
  // Por enquanto, retornamos a resposta completa para análise
  console.log('Resposta processada Toledo:', resposta);

  return resposta;
}

function lerPeso(
  timeout: number = 5000,
  tentarComandos: boolean = true
): Promise<string> {
  return new Promise(async (resolve, reject) => {
    if (!parser || !serialPort || !serialPort.isOpen) {
      reject(new Error('Conexão serial não está aberta'));
      return;
    }

    console.log('Aguardando dados da balança (timeout:', timeout, 'ms)...');

    // Se tentarComandos for true, enviar comando Toledo específico
    if (tentarComandos) {
      try {
        // Comando Toledo: "P" solicita o peso atual
        // Toledo geralmente usa \r\n como terminação de comando
        console.log('Enviando comando Toledo "P" para solicitar peso...');
        await enviarComando('P\r\n');
        // Aguardar um pouco para a balança processar e responder
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.log(
          'Erro ao enviar comando Toledo (continuando mesmo assim):',
          err
        );
      }
    }

    let dadosRecebidos = false;
    const timeoutId = setTimeout(() => {
      if (!dadosRecebidos) {
        console.log('Timeout: Nenhum dado recebido da balança');
        reject(
          new Error(
            'Timeout: Nenhum dado recebido da balança. Verifique se a balança está ligada e conectada corretamente.'
          )
        );
      }
    }, timeout);

    // Listener temporário para capturar dados do parser
    const onData = (data: string) => {
      console.log('Dado recebido no lerPeso (raw):', data);
      console.log(
        'Dado recebido (hex):',
        Buffer.from(data, 'utf8').toString('hex')
      );

      // Processar resposta Toledo
      const respostaProcessada = processarRespostaToledo(data);

      // Ignorar dados vazios ou muito pequenos (provavelmente ruído)
      if (!respostaProcessada || respostaProcessada.length === 0) {
        console.log('Dado vazio ignorado');
        return;
      }

      dadosRecebidos = true;
      clearTimeout(timeoutId);
      parser!.removeListener('data', onData);

      // Tentar extrair apenas o peso numérico se possível
      // Formato Toledo pode ter: STX SWA SWB SWC MSD...LSD CR CHK
      // Vamos tentar extrair números da resposta
      const matchPeso = respostaProcessada.match(/-?\d+\.?\d*/);
      const pesoFinal = matchPeso ? matchPeso[0] : respostaProcessada;

      console.log('Peso extraído:', pesoFinal);
      resolve(pesoFinal);
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
    console.log('Iniciando teste de conexão...');
    await abrirConexaoSerial(config);

    // Aguardar um pouco mais para garantir que a conexão está estável
    await new Promise((resolve) => setTimeout(resolve, 300));

    console.log('Tentando ler peso da balança Toledo...');
    // Toledo requer comando "P" para enviar dados
    const peso = await lerPeso(5000, true);

    console.log('Peso lido com sucesso:', peso);

    fecharConexaoSerial();
    return { sucesso: true, peso };
  } catch (error: any) {
    console.error('Erro ao testar conexão:', error);
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
