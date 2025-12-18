import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { Transform } from 'stream';

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

      // Criar um Transform stream para capturar dados brutos antes do parser
      const dataCapture = new Transform({
        transform(chunk: Buffer, encoding: string, callback: () => void) {
          console.log(
            'Dados brutos capturados:',
            chunk.toString('hex'),
            '| Texto:',
            chunk.toString()
          );
          this.push(chunk);
          callback();
        },
      });

      // Toledo usa CR (\r) como delimitador no protocolo TOLEDO Continuous
      // Formato: STX ... dados ... CR CHK
      // Capturar dados brutos antes de passar para o parser
      const newParser = serialPort!
        .pipe(dataCapture)
        .pipe(new ReadlineParser({ delimiter: '\r' }));
      parser = newParser;

      newParser.on('data', (data: string) => {
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
  timeout: number = 10000,
  tentarComandos: boolean = true
): Promise<string> {
  return new Promise(async (resolve, reject) => {
    if (!parser || !serialPort || !serialPort.isOpen) {
      reject(new Error('Conexão serial não está aberta'));
      return;
    }

    console.log('Aguardando dados da balança (timeout:', timeout, 'ms)...');

    // Primeiro, tentar ler dados sem enviar comandos (modo contínuo)
    // Algumas balanças Toledo enviam dados automaticamente
    console.log('Tentando ler dados em modo contínuo (sem comandos)...');
    let dadosRecebidosModoContinuo = false;
    const timeoutModoContinuo = setTimeout(() => {
      if (!dadosRecebidosModoContinuo) {
        console.log(
          'Nenhum dado recebido em modo contínuo, tentando comandos...'
        );
      }
    }, 2000);

    const onDataContinuo = (data: string) => {
      const peso = data.trim();
      if (peso && peso.length > 0) {
        dadosRecebidosModoContinuo = true;
        clearTimeout(timeoutModoContinuo);
        parser!.removeListener('data', onDataContinuo);
        console.log('Dados recebidos em modo contínuo:', peso);
        const matchPeso = peso.match(/-?\d+\.?\d*/);
        const pesoFinal = matchPeso ? matchPeso[0] : peso;
        resolve(pesoFinal);
      }
    };

    parser.once('data', onDataContinuo);

    // Se tentarComandos for true, tentar diferentes formatos de comando Toledo
    if (tentarComandos) {
      // Aguardar um pouco antes de enviar comandos
      await new Promise((r) => setTimeout(r, 2500));

      if (dadosRecebidosModoContinuo) {
        return; // Já recebeu dados, não precisa enviar comandos
      }

      try {
        // Tentar diferentes formatos de comando Toledo
        // ENQ (0x05) é usado por algumas balanças Toledo
        const comandos = [
          Buffer.from([0x05]), // ENQ - comando ASCII 0x05
          'P\r\n', // Comando padrão com CR+LF
          'P\r', // Comando com apenas CR
          'P\n', // Comando com apenas LF
          'P', // Comando sem terminação
          '\r\n', // Apenas ENTER
          '\r', // Apenas CR
        ];

        console.log('Tentando diferentes formatos de comando Toledo...');
        for (let i = 0; i < comandos.length; i++) {
          const cmd = comandos[i];
          const cmdDesc = Buffer.isBuffer(cmd)
            ? `ENQ (0x05)`
            : `"${cmd.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
          console.log(
            `Tentativa ${i + 1}/${comandos.length}: Enviando comando ${cmdDesc}`
          );
          try {
            await enviarComando(cmd);
            // Aguardar resposta antes de tentar próximo comando
            await new Promise((r) => setTimeout(r, 600));
          } catch (err) {
            console.log(`Erro ao enviar comando ${i + 1}:`, err);
          }
        }
        console.log('Todos os comandos enviados, aguardando resposta...');
      } catch (err) {
        console.log(
          'Erro ao enviar comandos Toledo (continuando mesmo assim):',
          err
        );
      }
    }

    let dadosRecebidos = false;
    const timeoutId = setTimeout(() => {
      if (!dadosRecebidos && !dadosRecebidosModoContinuo) {
        console.log('Timeout: Nenhum dado recebido da balança');
        console.log('');
        console.log('=== DIAGNÓSTICO ===');
        console.log('Nenhum dado foi recebido da balança.');
        console.log('');
        console.log('Verifique:');
        console.log('  1. A balança está ligada e funcionando');
        console.log('  2. O cabo serial está conectado corretamente');
        console.log(
          '  3. A porta COM está correta (verifique no Gerenciador de Dispositivos)'
        );
        console.log('  4. A balança está configurada para comunicação serial');
        console.log('     - Acesse o menu da balança');
        console.log('     - Procure por "Comunicação Serial" ou "RS232"');
        console.log(
          '     - Configure o protocolo (Prt1, TOLEDO Continuous, etc.)'
        );
        console.log(
          '  5. Os parâmetros de comunicação na balança correspondem:'
        );
        console.log('     - Baud Rate: 9600');
        console.log('     - Data Bits: 8');
        console.log('     - Parity: None');
        console.log('     - Stop Bits: 1');
        console.log('  6. Nenhum outro programa está usando a porta COM');
        console.log('');
        console.log(
          'Se a balança envia dados automaticamente (modo contínuo),'
        );
        console.log('certifique-se de que essa opção está habilitada no menu.');
        console.log('');
        reject(
          new Error(
            'Timeout: Nenhum dado recebido da balança. Verifique se a balança está ligada e configurada corretamente.'
          )
        );
      }
    }, timeout);

    // Listener temporário para capturar dados do parser (após comandos)
    const onData = (data: string) => {
      // Se já recebeu dados em modo contínuo, ignorar
      if (dadosRecebidosModoContinuo) {
        return;
      }

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
      clearTimeout(timeoutModoContinuo);
      parser!.removeListener('data', onData);
      parser!.removeListener('data', onDataContinuo);

      // Tentar extrair apenas o peso numérico se possível
      // Formato Toledo pode ter: STX SWA SWB SWC MSD...LSD CR CHK
      // Ou formato [STX][PPPPP][ETX] onde PPPPP é o peso
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
    // Toledo pode funcionar em modo contínuo ou com comandos
    // Timeout aumentado para 10 segundos para dar tempo da balança responder
    const peso = await lerPeso(10000, true);

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
