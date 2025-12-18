import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { Transform } from 'stream';

let mainWindow: BrowserWindow | null = null;
let webViewWindow: BrowserWindow | null = null;
let serialPort: SerialPort | null = null;
let parser: ReadlineParser | null = null;
// Callback para processar peso quando recebido diretamente
let callbackPesoRecebido: ((peso: string) => void) | null = null;

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
      // Configurações de fluxo de controle - algumas balanças precisam disso
      rtscts: false, // RTS/CTS hardware flow control
      xon: false, // XON/XOFF software flow control
      xoff: false,
      xany: false,
      // Configurações adicionais
      highWaterMark: 64 * 1024, // Buffer size
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
      console.log('Estado da porta:', {
        isOpen: serialPort!.isOpen,
        baudRate: serialPort!.baudRate,
        path: serialPort!.path,
      });

      // Configurar sinais de controle (algumas balanças precisam disso)
      try {
        serialPort!.set({ rts: true, dtr: true });
        console.log('Sinais RTS e DTR configurados');
      } catch (err) {
        console.log('Aviso: Não foi possível configurar RTS/DTR:', err);
      }

      // Criar um Transform stream para capturar dados brutos antes do parser
      const dataCapture = new Transform({
        transform(chunk: Buffer, encoding: string, callback: () => void) {
          const hex = chunk.toString('hex');
          const text = chunk.toString('utf8', 0, Math.min(chunk.length, 100)); // Limitar tamanho do log
          console.log(
            '=== DADOS BRUTOS CAPTURADOS ===',
            '\nHex:',
            hex,
            '\nTexto:',
            text,
            '\nTamanho:',
            chunk.length,
            'bytes',
            '\n=============================='
          );
          this.push(chunk);
          callback();
        },
      });

      // Adicionar listener direto no serialPort para capturar TUDO antes do pipe
      // Isso é importante porque o pipe pode consumir os dados
      // Toledo responde no formato: STX (0x02) + dados + ETX (0x03)
      serialPort!.on('data', (data: Buffer) => {
        const hex = data.toString('hex');
        const text = data.toString('utf8', 0, Math.min(data.length, 100));
        console.log(
          '=== DADOS RECEBIDOS DIRETAMENTE DA PORTA ===',
          '\nHex:',
          hex,
          '\nTexto:',
          text,
          '\nTamanho:',
          data.length,
          'bytes',
          '\n=========================================='
        );

        // Processar resposta Toledo imediatamente se estiver no formato STX...ETX
        if (
          data.length >= 3 &&
          data[0] === 0x02 &&
          data[data.length - 1] === 0x03
        ) {
          const pesoBruto = processarRespostaToledo(data);
          if (pesoBruto) {
            // Converter peso para quilogramas
            const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);
            if (pesoEmKg) {
              console.log(
                'Peso processado do listener direto:',
                pesoEmKg,
                'kg'
              );
              // Enviar peso para a janela principal
              mainWindow?.webContents.send('peso-balanca', pesoEmKg);
              // Se há um callback esperando, chamá-lo
              if (callbackPesoRecebido) {
                callbackPesoRecebido(pesoEmKg);
                callbackPesoRecebido = null;
              }
            }
          }
        }
      });

      // Toledo pode usar ETX (0x03) como delimitador no formato STX...ETX
      // Ou CR (\r) no protocolo TOLEDO Continuous
      // Vamos usar ETX como delimitador principal
      const newParser = serialPort!
        .pipe(dataCapture)
        .pipe(new ReadlineParser({ delimiter: Buffer.from([0x03]) })); // ETX como delimitador
      parser = newParser;

      newParser.on('data', (data: string) => {
        // Remover caracteres de controle (STX, ETX, etc.) e espaços
        let pesoBruto = data.replace(/[\x00-\x1F\x7F]/g, '').trim();
        console.log('Peso recebido (parser) - Raw:', JSON.stringify(pesoBruto));
        console.log('Peso recebido (parser) - Length:', pesoBruto.length);
        console.log(
          'Peso recebido (parser) - Hex:',
          Buffer.from(pesoBruto, 'utf8').toString('hex')
        );

        // Converter peso para quilogramas
        const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);
        console.log('Resultado da conversão:', pesoEmKg);
        if (!pesoEmKg) {
          console.log('Peso inválido recebido do parser, ignorando...');
          return;
        }

        // Enviar peso convertido para a janela principal
        mainWindow?.webContents.send('peso-balanca', pesoEmKg);

        // Se há um callback esperando, chamá-lo com o peso convertido
        // Isso resolve a Promise da função lerPeso
        if (callbackPesoRecebido) {
          console.log('Chamando callback com peso convertido:', pesoEmKg);
          callbackPesoRecebido(pesoEmKg);
          callbackPesoRecebido = null;
        }

        // Enviar peso para a WebView via JavaScript injetado
        if (webViewWindow && !webViewWindow.isDestroyed()) {
          // Criar um evento customizado na página da WebView
          const script = `
            (function() {
              // Disparar evento customizado
              window.dispatchEvent(new CustomEvent('peso-balanca', { detail: '${pesoEmKg.replace(
                /'/g,
                "\\'"
              )}' }));
              
              // Também disponibilizar via função global (caso a página precise)
              if (typeof window.onPesoBalança === 'function') {
                window.onPesoBalança('${pesoEmKg.replace(/'/g, "\\'")}');
              }
              
              // E via propriedade global
              window.pesoBalançaAtual = '${pesoEmKg.replace(/'/g, "\\'")}';
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
    const hex = buffer.toString('hex');
    const text = buffer.toString('utf8', 0, Math.min(buffer.length, 50));

    console.log(
      '=== ENVIANDO COMANDO ===',
      '\nHex:',
      hex,
      '\nTexto:',
      text.replace(/\r/g, '\\r').replace(/\n/g, '\\n'),
      '\nTamanho:',
      buffer.length,
      'bytes',
      '\n======================'
    );

    serialPort.write(buffer, (err) => {
      if (err) {
        console.error('Erro ao enviar comando:', err);
        reject(err);
      } else {
        console.log('Comando enviado com sucesso, aguardando resposta...');
        // Aguardar um pouco para garantir que o comando foi enviado
        setTimeout(() => {
          resolve();
        }, 50);
      }
    });
  });
}

// Função para converter peso bruto da balança para quilogramas
// Entrada: string com dígitos (ex: "00415", "ST,GS, 00415 kg", etc.)
// Saída: string formatada em kg com 3 casas decimais (ex: "0.415") ou null se inválido
function converterPesoParaQuilogramas(pesoBruto: string): string | null {
  if (!pesoBruto || typeof pesoBruto !== 'string') {
    return null;
  }

  // Extrair apenas dígitos numéricos (incluindo possível sinal negativo)
  const matchDigitos = pesoBruto.match(/-?\d+/);

  if (!matchDigitos || matchDigitos[0].length === 0) {
    console.log('Nenhum dígito numérico encontrado no peso bruto:', pesoBruto);
    return null;
  }

  const digitos = matchDigitos[0];

  // Converter para número
  const valorNumerico = parseInt(digitos, 10);

  // Verificar se é um número válido
  if (isNaN(valorNumerico)) {
    console.log('Valor numérico inválido:', digitos);
    return null;
  }

  // Verificar se o valor é razoável (entre -999999 e 999999 para evitar valores absurdos)
  if (Math.abs(valorNumerico) > 999999) {
    console.log('Valor fora do range esperado:', valorNumerico);
    return null;
  }

  // Dividir por 1000 para converter para quilogramas
  const pesoEmKg = valorNumerico / 1000;

  // Formatar com 3 casas decimais
  const pesoFormatado = pesoEmKg.toFixed(3);

  console.log(
    `Conversão: "${pesoBruto}" -> ${digitos} -> ${pesoEmKg} kg -> "${pesoFormatado}" kg`
  );

  return pesoFormatado;
}

// Função para processar resposta no formato Toledo
// Formato: STX (0x02) + peso + ETX (0x03)
// Exemplo: 02 30 30 34 31 35 03 = STX "00415" ETX
function processarRespostaToledo(data: string | Buffer): string {
  let buffer: Buffer;

  // Converter string para Buffer se necessário
  if (typeof data === 'string') {
    buffer = Buffer.from(data, 'utf8');
  } else {
    buffer = data;
  }

  // Verificar se começa com STX (0x02) e termina com ETX (0x03)
  if (
    buffer.length >= 3 &&
    buffer[0] === 0x02 &&
    buffer[buffer.length - 1] === 0x03
  ) {
    // Extrair apenas os dados entre STX e ETX
    const dadosPeso = buffer.slice(1, -1);
    const peso = dadosPeso.toString('utf8').trim();
    console.log('Resposta Toledo processada - Peso extraído:', peso);
    return peso;
  }

  // Se não estiver no formato esperado, tentar remover caracteres de controle
  let resposta = buffer
    .toString('utf8')
    .replace(/[\x02\x03]/g, '')
    .trim();
  console.log('Resposta processada Toledo (formato alternativo):', resposta);

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

    let dadosRecebidosModoContinuo = false;
    let pesoResolvido = false;
    let timeoutId: NodeJS.Timeout | null = null;
    let timeoutModoContinuo: NodeJS.Timeout | null = null;

    // Primeiro, tentar ler dados sem enviar comandos (modo contínuo)
    // Algumas balanças Toledo enviam dados automaticamente
    console.log('Tentando ler dados em modo contínuo (sem comandos)...');
    timeoutModoContinuo = setTimeout(() => {
      if (!dadosRecebidosModoContinuo) {
        console.log(
          'Nenhum dado recebido em modo contínuo, tentando comandos...'
        );
      }
    }, 2000);

    // Configurar callback para receber peso do listener direto ou parser
    // O peso já vem convertido do parser/listener, então apenas resolve a Promise
    callbackPesoRecebido = (pesoConvertido: string) => {
      if (!pesoResolvido) {
        // Validar que é um peso válido
        if (
          !pesoConvertido ||
          typeof pesoConvertido !== 'string' ||
          pesoConvertido.trim().length === 0
        ) {
          console.log('Peso vazio recebido via callback, ignorando...');
          return; // Não resolver, continuar esperando
        }

        // Verificar se o peso é válido (não é "0.000" a menos que seja realmente zero)
        const pesoNum = parseFloat(pesoConvertido);
        if (isNaN(pesoNum)) {
          console.log(
            'Peso não numérico recebido via callback:',
            pesoConvertido
          );
          return; // Não resolver, continuar esperando
        }

        pesoResolvido = true;
        dadosRecebidosModoContinuo = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (timeoutModoContinuo) clearTimeout(timeoutModoContinuo);
        callbackPesoRecebido = null;

        console.log(
          'Peso recebido via callback - resolvendo Promise com:',
          pesoConvertido,
          'kg'
        );
        resolve(pesoConvertido);
      }
    };

    const onDataContinuo = (data: string | Buffer) => {
      if (pesoResolvido) return;

      let buffer: Buffer;
      if (typeof data === 'string') {
        buffer = Buffer.from(data, 'utf8');
      } else {
        buffer = data;
      }

      // Verificar se está no formato STX...ETX
      if (
        buffer.length >= 3 &&
        buffer[0] === 0x02 &&
        buffer[buffer.length - 1] === 0x03
      ) {
        const pesoBruto = processarRespostaToledo(buffer);
        if (pesoBruto && pesoBruto.length > 0) {
          // Converter peso para quilogramas
          const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);

          if (pesoEmKg === null) {
            console.log(
              'Peso inválido recebido em modo contínuo, ignorando...'
            );
            return; // Não resolver, continuar esperando
          }

          dadosRecebidosModoContinuo = true;
          pesoResolvido = true;
          if (timeoutModoContinuo) clearTimeout(timeoutModoContinuo);
          if (timeoutId) clearTimeout(timeoutId);
          parser!.removeListener('data', onDataContinuo);
          callbackPesoRecebido = null;
          console.log('Dados recebidos em modo contínuo:', pesoEmKg, 'kg');
          resolve(pesoEmKg);
        }
      } else {
        // Formato alternativo
        const pesoBruto =
          typeof data === 'string'
            ? data.trim()
            : buffer.toString('utf8').trim();
        if (pesoBruto && pesoBruto.length > 0) {
          // Converter peso para quilogramas
          const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);

          if (pesoEmKg === null) {
            console.log(
              'Peso inválido recebido em modo contínuo (formato alternativo), ignorando...'
            );
            return; // Não resolver, continuar esperando
          }

          dadosRecebidosModoContinuo = true;
          pesoResolvido = true;
          if (timeoutModoContinuo) clearTimeout(timeoutModoContinuo);
          if (timeoutId) clearTimeout(timeoutId);
          parser!.removeListener('data', onDataContinuo);
          callbackPesoRecebido = null;
          console.log(
            'Dados recebidos em modo contínuo (formato alternativo):',
            pesoEmKg,
            'kg'
          );
          resolve(pesoEmKg);
        }
      }
    };

    parser.once('data', onDataContinuo);

    // Se tentarComandos for true, tentar diferentes formatos de comando Toledo
    if (tentarComandos) {
      // Aguardar um pouco antes de enviar comandos
      await new Promise((r) => setTimeout(r, 2500));

      if (dadosRecebidosModoContinuo || pesoResolvido) {
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
    timeoutId = setTimeout(() => {
      // Limpar callback se timeout ocorrer
      callbackPesoRecebido = null;

      if (!dadosRecebidos && !dadosRecebidosModoContinuo && !pesoResolvido) {
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
    // Este listener só será usado se o callback não processar os dados
    const onData = (data: string | Buffer) => {
      // Se já recebeu dados em modo contínuo ou já foi resolvido, ignorar
      if (dadosRecebidosModoContinuo || pesoResolvido) {
        return;
      }

      console.log('Dado recebido no lerPeso (raw):', data);

      let buffer: Buffer;
      if (typeof data === 'string') {
        buffer = Buffer.from(data, 'utf8');
      } else {
        buffer = data;
      }

      console.log('Dado recebido (hex):', buffer.toString('hex'));

      // Remover caracteres de controle
      let pesoBruto = buffer
        .toString('utf8')
        .replace(/[\x00-\x1F\x7F]/g, '')
        .trim();

      // Converter peso para quilogramas
      const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);

      if (pesoEmKg === null) {
        console.log('Peso inválido recebido do parser no onData, ignorando...');
        return; // Não resolver, continuar esperando
      }

      dadosRecebidos = true;
      pesoResolvido = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (timeoutModoContinuo) clearTimeout(timeoutModoContinuo);
      parser!.removeListener('data', onData);
      parser!.removeListener('data', onDataContinuo);
      callbackPesoRecebido = null;

      console.log('Peso extraído e convertido (onData):', pesoEmKg, 'kg');
      resolve(pesoEmKg);
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
