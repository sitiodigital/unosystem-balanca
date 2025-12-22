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
// Flag para controlar se o MessageChannel já foi inicializado na WebView
let messageChannelInicializado: boolean = false;
// Cache do comando que funciona (para leituras rápidas)
let comandoFuncionando: string | Buffer | null = null;

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

  // Resetar flag quando criar nova WebView
  messageChannelInicializado = false;

  // Quando a página carregar completamente, inicializar o MessageChannel
  webViewWindow.webContents.on('did-finish-load', () => {
    // Resetar flag quando a página recarregar
    messageChannelInicializado = false;
    // Aguardar um pouco para garantir que o JavaScript da página foi executado
    // e que o listener window.addEventListener('message') já está registrado
    setTimeout(() => {
      // Configurar escuta de solicitação de peso PRIMEIRO (cria função global)
      configurarEscutaSolicitacaoPeso();
      // Depois inicializar MessageChannel (que usará a função global)
      inicializarMessageChannel();
      // Configurar escuta para mensagens de navegação (deve ser configurado após o carregamento)
      configurarEscutaNavegacao();
    }, 300); // Reduzido de 500ms para 300ms
  });

  webViewWindow.on('closed', () => {
    webViewWindow = null;
    messageChannelInicializado = false;
  });
}

// Função para inicializar o MessageChannel na WebView
// Isso cria um canal de comunicação que permite ao JavaScript usar _port.postMessage()
function inicializarMessageChannel(): void {
  if (
    !webViewWindow ||
    webViewWindow.isDestroyed() ||
    messageChannelInicializado
  ) {
    return;
  }

  const script = `
    (function() {
      // Criar MessageChannel apenas uma vez
      if (window._balancaMessageChannel) {
        console.log('MessageChannel já inicializado');
        return; // Já foi inicializado
      }

      try {
        // Criar um MessageChannel
        const channel = new MessageChannel();
        const port1 = channel.port1;
        const port2 = channel.port2;

        // Armazenar o port2 para uso posterior (caso necessário)
        window._balancaPort2 = port2;

        // Criar um listener no port2 para receber mensagens do JavaScript
        // Quando o JavaScript enviar 'message' via _port.postMessage('message'),
        // isso indica que o usuário solicitou o peso (clicou no botão)
        port2.onmessage = function(event) {
          console.log('Solicitação de peso recebida do JavaScript via port:', event.data);
          // Quando receber 'message', solicitar um novo peso da balança
          // Usar função global para comunicação rápida
          if (typeof window.__electronSolicitarPeso === 'function') {
            window.__electronSolicitarPeso();
          } else {
            // Fallback: disparar evento customizado
            window.dispatchEvent(new CustomEvent('electron-solicitar-peso-balança', { 
              detail: { origem: 'port-message' } 
            }));
          }
        };

        // Iniciar o port2 para receber mensagens
        port2.start();

        // Enviar o port1 para a própria janela via postMessage
        // Isso fará com que o listener window.addEventListener('message') receba o port
        // O código JavaScript espera: event.ports[0] na primeira mensagem
        // IMPORTANTE: Um port só pode ser transferido uma vez via postMessage
        // Após ser transferido, ele fica "neutered" e não pode ser usado novamente
        window.postMessage({ peso: null }, '*', [port1]);

        // Marcar como inicializado
        window._balancaMessageChannel = channel;

        console.log('MessageChannel inicializado para comunicação com balança - port1 enviado');
      } catch (error) {
        console.error('Erro ao criar MessageChannel:', error);
      }
    })();
  `;

  webViewWindow.webContents
    .executeJavaScript(script)
    .then(() => {
      messageChannelInicializado = true;
      console.log('MessageChannel inicializado com sucesso na WebView');
    })
    .catch((err) => {
      console.error('Erro ao inicializar MessageChannel:', err);
      // Tentar novamente após um delay
      setTimeout(() => {
        if (!messageChannelInicializado) {
          inicializarMessageChannel();
        }
      }, 1000);
    });
}

// Função para configurar escuta de solicitação de peso da WebView
function configurarEscutaSolicitacaoPeso(): void {
  if (!webViewWindow || webViewWindow.isDestroyed()) {
    return;
  }

  // Injetar código que escuta o evento customizado e notifica o processo principal
  // Usar comunicação direta via postMessage para melhor performance
  const script = `
    (function() {
      // Escutar evento customizado disparado pelo port2
      window.addEventListener('electron-solicitar-peso-balança', function(event) {
        // Enviar mensagem diretamente via postMessage (mais rápido que console.log)
        // O processo principal escutará via webContents.on('did-finish-load') e injetará listener
        window.postMessage({ tipo: '__ELECTRON_SOLICITAR_PESO__' }, '*');
      });
      
      // Também escutar mensagens postMessage para detectar solicitações
      const originalAddEventListener = window.addEventListener;
      window.addEventListener('message', function(event) {
        if (event.data && event.data.tipo === '__ELECTRON_SOLICITAR_PESO__') {
          // Disparar evento interno que será capturado pelo processo principal
          window.dispatchEvent(new CustomEvent('electron-peso-solicitado'));
        }
      }, true);
      
      console.log('Escuta de solicitação de peso configurada');
    })();
  `;

  webViewWindow.webContents.executeJavaScript(script).catch((err) => {
    console.error('Erro ao configurar escuta de solicitação:', err);
  });

  // Escutar mensagens postMessage da WebView (mais rápido que console)
  webViewWindow.webContents.on('did-finish-load', () => {
    // Injetar listener que captura mensagens e notifica diretamente
    const listenerScript = `
      (function() {
        window.addEventListener('electron-peso-solicitado', function() {
          // Esta mensagem será capturada pelo processo principal via executeJavaScript
          // Usar um elemento DOM temporário para comunicação rápida
          const trigger = document.createElement('div');
          trigger.id = '__electron_solicitar_peso_trigger__';
          trigger.style.display = 'none';
          document.body.appendChild(trigger);
          setTimeout(() => trigger.remove(), 10);
        });
      })();
    `;
    webViewWindow!.webContents
      .executeJavaScript(listenerScript)
      .catch(() => {});
  });

  // Usar uma abordagem mais simples e direta: injetar função global que chama diretamente
  // Isso evita latência de console.log ou polling
  webViewWindow.webContents
    .executeJavaScript(
      `
    (function() {
      // Criar função global que será chamada quando solicitar peso
      window.__electronSolicitarPeso = function() {
        // Criar elemento temporário que será detectado
        const el = document.createElement('div');
        el.id = '__electron_solicitar_peso_now__';
        el.style.display = 'none';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 50);
      };
    })();
  `
    )
    .catch(() => {});

  // Verificar periodicamente de forma mais eficiente (a cada 50ms)
  const verificarSolicitacao = () => {
    if (!webViewWindow || webViewWindow.isDestroyed()) return;

    webViewWindow.webContents
      .executeJavaScript(
        `
      document.getElementById('__electron_solicitar_peso_now__') !== null
    `
      )
      .then((existe) => {
        if (existe) {
          solicitarPesoParaWebView();
        }
        // Continuar verificando
        setTimeout(verificarSolicitacao, 50);
      })
      .catch(() => {
        setTimeout(verificarSolicitacao, 50);
      });
  };

  // Iniciar verificação após um pequeno delay
  setTimeout(verificarSolicitacao, 500);

  // Atualizar o listener do port2 para usar a função global
  webViewWindow.webContents
    .executeJavaScript(
      `
    (function() {
      if (window._balancaPort2) {
        const originalOnMessage = window._balancaPort2.onmessage;
        window._balancaPort2.onmessage = function(event) {
          if (originalOnMessage) originalOnMessage.call(this, event);
          if (typeof window.__electronSolicitarPeso === 'function') {
            window.__electronSolicitarPeso();
          }
        };
      }
    })();
  `
    )
    .catch(() => {});
}

// Função para configurar escuta de mensagens de navegação da WebView
function configurarEscutaNavegacao(): void {
  if (!webViewWindow || webViewWindow.isDestroyed()) {
    return;
  }

  console.log('Configurando escuta de navegação na WebView');

  // Criar função global que será chamada quando solicitar navegação
  webViewWindow.webContents
    .executeJavaScript(
      `
    (function() {
      // Criar função global que será chamada quando solicitar abrir tela inicial
      if (!window.__electronAbrirTelaInicial) {
        window.__electronAbrirTelaInicial = function() {
          console.log('Função __electronAbrirTelaInicial chamada');
          // Criar elemento temporário que será detectado pelo processo principal
          const el = document.createElement('div');
          el.id = '__electron_abrir_tela_inicial__';
          el.style.display = 'none';
          document.body.appendChild(el);
          setTimeout(() => el.remove(), 50);
        };
      }
      
      // Escutar mensagens postMessage para navegação
      // Remover listener anterior se existir para evitar duplicatas
      if (window.__electronNavigationListener) {
        window.removeEventListener('message', window.__electronNavigationListener);
      }
      
      window.__electronNavigationListener = function(event) {
        if (event.data && event.data.tipo === '__ELECTRON_ABRIR_TELA_INICIAL__') {
          console.log('Mensagem de navegação recebida:', event.data);
          if (typeof window.__electronAbrirTelaInicial === 'function') {
            window.__electronAbrirTelaInicial();
          }
        }
      };
      
      window.addEventListener('message', window.__electronNavigationListener);
      console.log('Escuta de navegação configurada');
    })();
  `
    )
    .then(() => {
      console.log('Script de navegação injetado com sucesso');
    })
    .catch((err) => {
      console.error('Erro ao injetar script de navegação:', err);
    });

  // Verificar periodicamente se há solicitação para abrir tela inicial
  const verificarNavegacao = () => {
    if (!webViewWindow || webViewWindow.isDestroyed()) return;

    webViewWindow.webContents
      .executeJavaScript(
        `
      document.getElementById('__electron_abrir_tela_inicial__') !== null
    `
      )
      .then((existe) => {
        if (existe) {
          console.log('Solicitação para abrir tela inicial detectada');
          // Abrir/focar janela principal
          if (mainWindow) {
            if (mainWindow.isDestroyed()) {
              console.log('Criando nova janela principal');
              createWindow();
            } else {
              console.log('Focando janela principal existente');
              mainWindow.focus();
              mainWindow.show();
            }
          } else {
            console.log('Criando janela principal (não existe)');
            createWindow();
          }
        }
        // Continuar verificando
        setTimeout(verificarNavegacao, 100);
      })
      .catch((err) => {
        console.error('Erro ao verificar navegação:', err);
        setTimeout(verificarNavegacao, 100);
      });
  };

  // Iniciar verificação após um pequeno delay
  setTimeout(verificarNavegacao, 500);
}

// Função para solicitar peso da balança e enviar para WebView (otimizada para velocidade)
async function solicitarPesoParaWebView(): Promise<void> {
  if (!serialPort || !serialPort.isOpen) {
    console.log(
      'Conexão serial não está aberta, não é possível solicitar peso'
    );
    return;
  }

  try {
    console.log('Solicitando peso da balança (modo rápido)...');

    // Se já sabemos qual comando funciona, usar ele diretamente (muito mais rápido)
    if (comandoFuncionando) {
      const pesoEmKg = await lerPesoRapido(comandoFuncionando, 3000);
      if (pesoEmKg) {
        const pesoNumerico = Math.round(parseFloat(pesoEmKg) * 1000);
        enviarPesoParaWebView(pesoNumerico);
        return;
      }
    }

    // Se não temos comando em cache, usar função normal (mas com timeout menor)
    const pesoEmKg = await lerPeso(3000, true);
    console.log('Peso lido:', pesoEmKg);

    // Extrair valor numérico bruto (multiplicar por 1000 para converter de kg para gramas)
    const pesoNumerico = Math.round(parseFloat(pesoEmKg) * 1000);

    // Enviar para WebView
    enviarPesoParaWebView(pesoNumerico);
  } catch (error: any) {
    console.error('Erro ao solicitar peso:', error.message);
  }
}

// Função otimizada para leitura rápida usando comando conhecido
function lerPesoRapido(
  comando: string | Buffer,
  timeout: number = 3000
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!parser || !serialPort || !serialPort.isOpen) {
      reject(new Error('Conexão serial não está aberta'));
      return;
    }

    let pesoResolvido = false;
    let timeoutId: NodeJS.Timeout | null = null;

    // Callback rápido para receber peso
    const callbackRapido = (pesoConvertido: string) => {
      if (!pesoResolvido && pesoConvertido) {
        pesoResolvido = true;
        if (timeoutId) clearTimeout(timeoutId);
        callbackPesoRecebido = null;
        resolve(pesoConvertido);
      }
    };

    callbackPesoRecebido = callbackRapido;

    // Listener temporário para capturar resposta
    const onDataRapido = (data: string | Buffer) => {
      if (pesoResolvido) return;

      let buffer: Buffer =
        typeof data === 'string' ? Buffer.from(data, 'utf8') : data;

      // Processar resposta Toledo
      if (
        buffer.length >= 3 &&
        buffer[0] === 0x02 &&
        buffer[buffer.length - 1] === 0x03
      ) {
        const pesoBruto = processarRespostaToledo(buffer);
        if (
          pesoBruto &&
          !pesoBruto.match(/^[Nn]+$/) &&
          !pesoBruto.match(/^[Ee]+$/)
        ) {
          const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);
          if (pesoEmKg) {
            pesoResolvido = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (parser) {
              parser.removeListener('data', onDataRapido);
            }
            callbackPesoRecebido = null;
            resolve(pesoEmKg);
          }
        }
      }
    };

    if (parser) {
      parser.once('data', onDataRapido);
    }

    // Enviar comando imediatamente
    enviarComando(comando)
      .then(() => {
        // Timeout reduzido para resposta rápida
        timeoutId = setTimeout(() => {
          if (!pesoResolvido) {
            if (parser) {
              parser.removeListener('data', onDataRapido);
            }
            callbackPesoRecebido = null;
            reject(new Error('Timeout: Nenhuma resposta da balança'));
          }
        }, timeout);
      })
      .catch((err) => {
        if (parser) {
          parser.removeListener('data', onDataRapido);
        }
        callbackPesoRecebido = null;
        reject(err);
      });
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
            // Verificar se é uma resposta de status/erro (ex: "NNNNN")
            // Essas respostas indicam que a balança não está pronta ou estável
            if (pesoBruto.match(/^[Nn]+$/) || pesoBruto.match(/^[Ee]+$/)) {
              console.log(
                `Resposta de status/erro recebida: "${pesoBruto}" - Balança pode não estar estável ou pronta. Aguardando estabilização...`
              );
              // Não processar como peso válido, apenas logar
              return;
            }

            // Extrair valor numérico bruto para enviar à WebView
            const pesoNumerico = extrairValorNumericoBruto(pesoBruto);

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

              // Enviar peso numérico bruto para a WebView
              if (pesoNumerico !== null) {
                enviarPesoParaWebView(pesoNumerico);
              }

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

        // Verificar se é uma resposta de status/erro (ex: "NNNNN")
        // Essas respostas indicam que a balança não está pronta ou estável
        if (pesoBruto.match(/^[Nn]+$/) || pesoBruto.match(/^[Ee]+$/)) {
          console.log(
            `Resposta de status/erro recebida: "${pesoBruto}" - Balança pode não estar estável ou pronta. Aguardando estabilização...`
          );
          // Não processar como peso válido, apenas logar
          return;
        }

        // Extrair valor numérico bruto para enviar à WebView
        const pesoNumerico = extrairValorNumericoBruto(pesoBruto);

        // Converter peso para quilogramas
        const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);
        console.log('Resultado da conversão:', pesoEmKg);
        if (!pesoEmKg) {
          console.log('Peso inválido recebido do parser, ignorando...');
          return;
        }

        // Enviar peso convertido para a janela principal
        mainWindow?.webContents.send('peso-balanca', pesoEmKg);

        // Enviar peso numérico bruto para a WebView
        if (pesoNumerico !== null) {
          enviarPesoParaWebView(pesoNumerico);
        }

        // Se há um callback esperando, chamá-lo com o peso convertido
        // Isso resolve a Promise da função lerPeso
        if (callbackPesoRecebido) {
          console.log('Chamando callback com peso convertido:', pesoEmKg);
          callbackPesoRecebido(pesoEmKg);
          callbackPesoRecebido = null;
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

// Função para extrair valor numérico bruto do peso
// Entrada: string com dígitos (ex: "00415", "ST,GS, 00415 kg", etc.)
// Saída: número inteiro (ex: 415) ou null se inválido
function extrairValorNumericoBruto(pesoBruto: string): number | null {
  if (!pesoBruto || typeof pesoBruto !== 'string') {
    return null;
  }

  // Extrair apenas dígitos numéricos (incluindo possível sinal negativo)
  const matchDigitos = pesoBruto.match(/-?\d+/);

  if (!matchDigitos || matchDigitos[0].length === 0) {
    return null;
  }

  const digitos = matchDigitos[0];

  // Converter para número
  const valorNumerico = parseInt(digitos, 10);

  // Verificar se é um número válido
  if (isNaN(valorNumerico)) {
    return null;
  }

  // Verificar se o valor é razoável (entre -999999 e 999999 para evitar valores absurdos)
  if (Math.abs(valorNumerico) > 999999) {
    return null;
  }

  return valorNumerico;
}

// Função para converter peso bruto da balança para quilogramas
// Entrada: string com dígitos (ex: "00415", "ST,GS, 00415 kg", etc.)
// Saída: string formatada em kg com 3 casas decimais (ex: "0.415") ou null se inválido
function converterPesoParaQuilogramas(pesoBruto: string): string | null {
  const valorNumerico = extrairValorNumericoBruto(pesoBruto);

  if (valorNumerico === null) {
    console.log('Nenhum dígito numérico encontrado no peso bruto:', pesoBruto);
    return null;
  }

  // Dividir por 1000 para converter para quilogramas
  const pesoEmKg = valorNumerico / 1000;

  // Formatar com 3 casas decimais
  const pesoFormatado = pesoEmKg.toFixed(3);

  console.log(
    `Conversão: "${pesoBruto}" -> ${valorNumerico} -> ${pesoEmKg} kg -> "${pesoFormatado}" kg`
  );

  return pesoFormatado;
}

// Função para enviar peso para a WebView via postMessage
// O formato deve ser compatível com o listener: window.addEventListener('message', ...)
function enviarPesoParaWebView(pesoNumerico: number): void {
  if (!webViewWindow || webViewWindow.isDestroyed()) {
    return;
  }

  // Garantir que o MessageChannel está inicializado antes de enviar
  if (!messageChannelInicializado) {
    inicializarMessageChannel();
    // Aguardar um pouco para garantir que o MessageChannel foi inicializado
    setTimeout(() => {
      enviarPesoParaWebView(pesoNumerico);
    }, 500);
    return;
  }

  // Enviar via window.postMessage com o formato esperado pela WebView
  // O código JavaScript espera: event.data.peso
  const script = `
    (function() {
      try {
        // Criar um MessageEvent compatível com window.postMessage
        // O formato esperado é: { peso: valorNumerico }
        const messageData = { peso: ${pesoNumerico} };
        
        // Disparar o evento message na janela
        // Isso será capturado pelo listener: window.addEventListener('message', ...)
        window.postMessage(messageData, '*');
        
        console.log('Peso enviado para WebView:', ${pesoNumerico});
      } catch (error) {
        console.error('Erro ao enviar peso para WebView:', error);
      }
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
  tentarComandos: boolean = true,
  maxTentativas: number = 3
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
    // Reduzir tempo de espera no modo contínuo (de 2000ms para 800ms)
    console.log('Tentando ler dados em modo contínuo (sem comandos)...');
    timeoutModoContinuo = setTimeout(() => {
      if (!dadosRecebidosModoContinuo) {
        console.log(
          'Nenhum dado recebido em modo contínuo, tentando comandos...'
        );
      }
    }, 800);

    // Variáveis para armazenar referências dos listeners (serão definidas depois)
    let onDataContinuoRef: ((data: string | Buffer) => void) | null = null;
    let onDataRef: ((data: string | Buffer) => void) | null = null;

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

        // Remover listeners do parser para evitar erros (apenas se existirem)
        if (parser) {
          if (onDataContinuoRef) {
            parser.removeListener('data', onDataContinuoRef);
          }
          if (onDataRef) {
            parser.removeListener('data', onDataRef);
          }
        }

        console.log(
          'Peso recebido via callback - resolvendo Promise com:',
          pesoConvertido,
          'kg'
        );
        resolve(pesoConvertido);
      }
    };

    onDataContinuoRef = (data: string | Buffer) => {
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
          // Verificar se é uma resposta de status/erro (ex: "NNNNN")
          if (pesoBruto.match(/^[Nn]+$/) || pesoBruto.match(/^[Ee]+$/)) {
            console.log(
              `Resposta de status/erro recebida em modo contínuo: "${pesoBruto}" - Continuando a aguardar peso válido...`
            );
            return; // Não resolver, continuar esperando
          }

          // Extrair valor numérico bruto para enviar à WebView
          const pesoNumerico = extrairValorNumericoBruto(pesoBruto);

          // Converter peso para quilogramas
          const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);

          if (pesoEmKg === null) {
            console.log(
              'Peso inválido recebido em modo contínuo, ignorando...'
            );
            return; // Não resolver, continuar esperando
          }

          // Enviar peso numérico bruto para a WebView
          if (pesoNumerico !== null) {
            enviarPesoParaWebView(pesoNumerico);
          }

          dadosRecebidosModoContinuo = true;
          pesoResolvido = true;
          if (timeoutModoContinuo) clearTimeout(timeoutModoContinuo);
          if (timeoutId) clearTimeout(timeoutId);
          if (parser) {
            if (onDataContinuoRef) {
              parser.removeListener('data', onDataContinuoRef);
            }
            if (onDataRef) {
              parser.removeListener('data', onDataRef);
            }
          }
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
          // Verificar se é uma resposta de status/erro (ex: "NNNNN")
          if (pesoBruto.match(/^[Nn]+$/) || pesoBruto.match(/^[Ee]+$/)) {
            console.log(
              `Resposta de status/erro recebida em modo contínuo (formato alternativo): "${pesoBruto}" - Continuando a aguardar peso válido...`
            );
            return; // Não resolver, continuar esperando
          }

          // Extrair valor numérico bruto para enviar à WebView
          const pesoNumerico = extrairValorNumericoBruto(pesoBruto);

          // Converter peso para quilogramas
          const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);

          if (pesoEmKg === null) {
            console.log(
              'Peso inválido recebido em modo contínuo (formato alternativo), ignorando...'
            );
            return; // Não resolver, continuar esperando
          }

          // Enviar peso numérico bruto para a WebView
          if (pesoNumerico !== null) {
            enviarPesoParaWebView(pesoNumerico);
          }

          dadosRecebidosModoContinuo = true;
          pesoResolvido = true;
          if (timeoutModoContinuo) clearTimeout(timeoutModoContinuo);
          if (timeoutId) clearTimeout(timeoutId);
          if (parser) {
            if (onDataContinuoRef) {
              parser.removeListener('data', onDataContinuoRef);
            }
            if (onDataRef) {
              parser.removeListener('data', onDataRef);
            }
          }
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

    // Adicionar listener apenas se o parser existir
    if (parser && onDataContinuoRef) {
      parser.once('data', onDataContinuoRef);
    }

    // Se tentarComandos for true, tentar diferentes formatos de comando Toledo
    if (tentarComandos) {
      // Reduzir tempo de espera inicial (de 2500ms para 500ms)
      // Se já temos comando funcionando, não precisa aguardar
      const tempoEspera = comandoFuncionando ? 100 : 500;
      await new Promise((r) => setTimeout(r, tempoEspera));

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

        // Se temos comando funcionando, tentar ele primeiro
        const comandosParaTentar = comandoFuncionando
          ? [
              comandoFuncionando,
              ...comandos.filter((c) => c !== comandoFuncionando),
            ]
          : comandos;

        console.log('Tentando diferentes formatos de comando Toledo...');
        for (let i = 0; i < comandosParaTentar.length; i++) {
          // Verificar se já recebeu resposta válida antes de continuar
          if (pesoResolvido || dadosRecebidosModoContinuo) {
            console.log(
              `Resposta recebida após comando ${i}, interrompendo tentativas adicionais.`
            );
            // Salvar comando que funcionou
            if (i > 0 && comandosParaTentar[i - 1]) {
              comandoFuncionando = comandosParaTentar[i - 1];
              console.log(
                'Comando funcionando salvo em cache para leituras rápidas'
              );
            }
            break;
          }

          const cmd = comandosParaTentar[i];
          const cmdDesc = Buffer.isBuffer(cmd)
            ? `ENQ (0x05)`
            : `"${cmd.toString().replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
          console.log(
            `Tentativa ${i + 1}/${
              comandosParaTentar.length
            }: Enviando comando ${cmdDesc}`
          );
          try {
            await enviarComando(cmd);
            // Reduzir tempo de espera entre comandos (de 1500ms para 600ms)
            // Aumentar apenas se receber "NNNNN"
            await new Promise((r) => setTimeout(r, 600));

            // Verificar novamente se recebeu resposta após aguardar
            if (pesoResolvido || dadosRecebidosModoContinuo) {
              console.log(
                `Resposta recebida após comando ${
                  i + 1
                }, interrompendo tentativas adicionais.`
              );
              // Salvar comando que funcionou
              comandoFuncionando = cmd;
              console.log(
                'Comando funcionando salvo em cache para leituras rápidas'
              );
              break;
            }
          } catch (err) {
            console.log(`Erro ao enviar comando ${i + 1}:`, err);
          }
        }

        if (pesoResolvido || dadosRecebidosModoContinuo) {
          console.log(
            'Resposta recebida com sucesso, não é necessário aguardar mais comandos.'
          );
        } else {
          console.log('Todos os comandos enviados, aguardando resposta...');
        }
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
    onDataRef = (data: string | Buffer) => {
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

      // Verificar se é uma resposta de status/erro (ex: "NNNNN")
      if (pesoBruto.match(/^[Nn]+$/) || pesoBruto.match(/^[Ee]+$/)) {
        console.log(
          `Resposta de status/erro recebida no onData: "${pesoBruto}" - Continuando a aguardar peso válido...`
        );
        return; // Não resolver, continuar esperando
      }

      // Extrair valor numérico bruto para enviar à WebView
      const pesoNumerico = extrairValorNumericoBruto(pesoBruto);

      // Converter peso para quilogramas
      const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);

      if (pesoEmKg === null) {
        console.log('Peso inválido recebido do parser no onData, ignorando...');
        return; // Não resolver, continuar esperando
      }

      // Enviar peso numérico bruto para a WebView
      if (pesoNumerico !== null) {
        enviarPesoParaWebView(pesoNumerico);
      }

      dadosRecebidos = true;
      pesoResolvido = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (timeoutModoContinuo) clearTimeout(timeoutModoContinuo);
      if (parser) {
        if (onDataRef) {
          parser.removeListener('data', onDataRef);
        }
        if (onDataContinuoRef) {
          parser.removeListener('data', onDataContinuoRef);
        }
      }
      callbackPesoRecebido = null;

      console.log('Peso extraído e convertido (onData):', pesoEmKg, 'kg');
      resolve(pesoEmKg);
    };

    // Adicionar listener apenas se o parser existir e ainda não foi resolvido
    if (parser && !pesoResolvido && onDataRef) {
      parser.once('data', onDataRef);
    }
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

    // Aguardar mais tempo para garantir que a conexão está estável
    // Balanças Toledo podem precisar de mais tempo para estabilizar após conexão
    console.log('Aguardando estabilização da balança (2 segundos)...');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('Tentando ler peso da balança Toledo...');
    // Toledo pode funcionar em modo contínuo ou com comandos
    // Timeout aumentado para 15 segundos para dar tempo da balança estabilizar e responder
    const peso = await lerPeso(15000, true);

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

// Handler para focar/abrir a janela principal quando solicitado da WebView
ipcMain.handle('abrir-tela-inicial', async () => {
  try {
    if (mainWindow) {
      if (mainWindow.isDestroyed()) {
        createWindow();
      } else {
        mainWindow.focus();
        mainWindow.show();
      }
    } else {
      createWindow();
    }
    return { sucesso: true };
  } catch (error: any) {
    console.error('Erro ao abrir tela inicial:', error);
    return { sucesso: false, erro: error.message };
  }
});

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
