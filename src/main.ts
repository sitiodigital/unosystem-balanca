import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'path';
import Store from 'electron-store';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { Transform } from 'stream';

const store = new Store<{ pontoVendaBalanca: string | null }>({
  name: 'balanca-config',
});

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
const TIMEOUT_LEITURA_PESO_MS = 500;
const INTERVALO_MIN_LEITURA_SERIAL_MS = 400;
const DEDUPE_ENVIO_PESO_MS = 120;
let ultimoPesoNumericoEnviado: number | null = null;
let ultimoPesoBrutoRecebido: string | null = null;
let ultimoPesoEmKg: string | null = null;
let ultimoPesoEnviadoWebViewValor: number | null = null;
let ultimoPesoEnviadoWebViewMs = 0;
let ultimaLeituraSerialMs = 0;
let solicitacaoPesoEmAndamento = false;
// Flag para controlar se há instrução explícita de abrir tela inicial
let deveAbrirTelaInicial: boolean = false;
// Flag global para controlar se a janela principal pode ser mostrada
let podeMostrarJanelaPrincipal: boolean = false;
// Flag para controlar se o app está encerrando (evita loops infinitos)
let isQuitting: boolean = false;
// Mensagem de erro de conexão pendente para exibir na tela de configurações
let mensagemErroConexaoPendente: {
  mensagem: string;
  endereco?: string;
} | null = null;

const TIMEOUT_VALIDACAO_URL_MS = 10000;
// ERR_ABORTED – navegação cancelada (não é falha de conexão)
const CODIGOS_ERRO_CARREGAMENTO_IGNORAR = new Set([-3]);
// Armazenar IDs dos timers recursivos para poder cancelá-los durante o encerramento
let timerVerificarSolicitacao: NodeJS.Timeout | null = null;
let timerVerificarNavegacao: NodeJS.Timeout | null = null;
let timerVerificarESC: NodeJS.Timeout | null = null;

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
}

interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: 7 | 8;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
}

function focusExistingApplicationWindow(): void {
  const target =
    webViewWindow && !webViewWindow.isDestroyed()
      ? webViewWindow
      : mainWindow;

  if (!target || target.isDestroyed()) {
    return;
  }

  if (target === mainWindow) {
    podeMostrarJanelaPrincipal = true;
  }

  if (target.isMinimized()) {
    target.restore();
  }
  if (!target.isVisible()) {
    target.show();
  }
  target.setFullScreen(true);
  target.focus();

  if (process.platform === 'win32') {
    target.moveTop();
  }
}

function createWindow() {
  // Resetar flag quando criar nova janela (a menos que seja por instrução explícita)
  if (!deveAbrirTelaInicial) {
    podeMostrarJanelaPrincipal = false;
  }

  mainWindow = new BrowserWindow({
    width: 800,
    height: 700,
    fullscreen: true, // Abrir em tela cheia
    autoHideMenuBar: true, // Esconder barra de menu automaticamente
    show: false, // Não mostrar inicialmente - será mostrada apenas se necessário
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Garantir que a janela fique em fullscreen
  mainWindow.setFullScreen(true);

  // Remover menu completamente
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  // Prevenir que o menu apareça ao pressionar Alt
  mainWindow.on('focus', () => {
    mainWindow?.setMenuBarVisibility(false);
  });

  // Garantir que o fechamento da janela principal encerre o app completamente
  // No macOS, o comportamento padrão é manter o app ativo após fechar a janela
  // Vamos sobrescrever isso para garantir encerramento completo
  mainWindow.on('close', async (event) => {
    // Se não estiver encerrando ainda, iniciar processo de limpeza
    if (!isQuitting) {
      event.preventDefault(); // Prevenir fechamento imediato
      console.log(
        'Fechamento da janela principal detectado, iniciando encerramento...',
      );
      // Marcar que está encerrando para evitar loops
      isQuitting = true;
      // Chamar app.quit() que vai disparar before-quit e fazer a limpeza completa
      // Não chamar limparRecursosCompletamente() aqui para evitar duplicação
      app.quit();
    }
  });

  // Quando a janela principal carregar, verificar se deve redirecionar automaticamente
  mainWindow.webContents.on('did-finish-load', async () => {
    console.log(
      'Janela principal carregada, verificando se deve redirecionar...',
    );

    // Se há instrução explícita de abrir tela inicial, não redirecionar
    if (deveAbrirTelaInicial) {
      console.log(
        'Instrução explícita detectada no carregamento, permitindo mostrar janela principal',
      );
      podeMostrarJanelaPrincipal = true;
      deveAbrirTelaInicial = false; // Resetar após usar
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.setFullScreen(true);
        mainWindow.focus();
        enviarErroConexaoPendente();
      }
      return;
    }

    const redirecionou = await verificarERedirecionarAutomaticamente();
    // Se redirecionou automaticamente, manter a janela oculta
    if (redirecionou) {
      // Garantir que a janela principal permaneça oculta
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }
      console.log(
        'Redirecionamento automático realizado, mantendo janela principal oculta',
      );
    } else {
      // Se não redirecionou, permitir mostrar a janela principal
      podeMostrarJanelaPrincipal = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.setFullScreen(true);
        mainWindow.focus();
        console.log('Mostrando janela principal para preenchimento de dados');
      }
    }
  });

  // Prevenir que a janela seja mostrada antes da verificação
  mainWindow.on('show', () => {
    if (
      !podeMostrarJanelaPrincipal &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      console.log(
        'Tentativa de mostrar janela principal bloqueada (aguardando verificação)',
      );
      mainWindow.hide();
    }
  });
}

function formatarMensagemErroConexao(
  url: string,
  detalhe?: string,
): string {
  const motivo =
    detalhe && detalhe.trim().length > 0
      ? detalhe
      : 'Verifique se o servidor está ligado e se o IP, porta e URL estão corretos';
  return `Não foi possível conectar ao endereço configurado (${url}). ${motivo}.`;
}

function formatarErroFetch(error: unknown, url: string): string {
  const message =
    error instanceof Error ? error.message : 'Erro de rede desconhecido';

  if (
    message.includes('aborted') ||
    message.includes('AbortError') ||
    message.includes('Timeout') ||
    message.includes('UND_ERR_CONNECT_TIMEOUT')
  ) {
    return formatarMensagemErroConexao(
      url,
      'Tempo de conexão esgotado',
    );
  }

  if (message.includes('ECONNREFUSED')) {
    return formatarMensagemErroConexao(url, 'Conexão recusada pelo servidor');
  }

  if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
    return formatarMensagemErroConexao(
      url,
      'Endereço não encontrado (DNS)',
    );
  }

  if (message.includes('EHOSTUNREACH') || message.includes('ENETUNREACH')) {
    return formatarMensagemErroConexao(url, 'Endereço inacessível');
  }

  return formatarMensagemErroConexao(url, message);
}

function formatarErroCarregamentoWebView(
  errorCode: number,
  errorDescription: string,
  url: string,
): string {
  const mensagensPorCodigo: Record<number, string> = {
    [-102]: 'Conexão recusada pelo servidor',
    [-105]: 'Endereço não encontrado (DNS)',
    [-106]: 'Conexão com a internet indisponível',
    [-109]: 'Endereço inacessível',
    [-118]: 'Tempo de conexão esgotado',
    [-200]: 'Certificado SSL inválido',
    [-201]: 'Erro de certificado SSL',
  };

  const detalhe =
    mensagensPorCodigo[errorCode] ||
    (errorDescription && errorDescription.trim().length > 0
      ? errorDescription
      : undefined);

  return formatarMensagemErroConexao(url, detalhe);
}

async function validarUrlAcessivel(
  url: string,
): Promise<{ acessivel: boolean; erro?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    TIMEOUT_VALIDACAO_URL_MS,
  );

  try {
    await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });
    return { acessivel: true };
  } catch (error) {
    console.warn('Validação de URL falhou:', error);
    return { acessivel: false, erro: formatarErroFetch(error, url) };
  } finally {
    clearTimeout(timeoutId);
  }
}

function enviarErroConexaoPendente(): void {
  if (
    !mensagemErroConexaoPendente ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return;
  }

  mainWindow.webContents.send(
    'erro-conexao-sistema',
    mensagemErroConexaoPendente,
  );
  mensagemErroConexaoPendente = null;
}

function notificarErroConexaoSistema(mensagem: string, endereco?: string): void {
  const payload = { mensagem, endereco };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('erro-conexao-sistema', payload);
    return;
  }

  mensagemErroConexaoPendente = payload;
}

function destruirWebViewSemEncerrarApp(): void {
  if (timerVerificarNavegacao) {
    clearTimeout(timerVerificarNavegacao);
    timerVerificarNavegacao = null;
  }
  if (timerVerificarSolicitacao) {
    clearTimeout(timerVerificarSolicitacao);
    timerVerificarSolicitacao = null;
  }
  if (timerVerificarESC) {
    clearTimeout(timerVerificarESC);
    timerVerificarESC = null;
  }

  if (webViewWindow && !webViewWindow.isDestroyed()) {
    webViewWindow.removeAllListeners('close');
    webViewWindow.webContents.removeAllListeners();
    webViewWindow.removeAllListeners();
    webViewWindow.destroy();
    webViewWindow = null;
    messageChannelInicializado = false;
    console.log('WebView descartada após falha de carregamento');
  }
}

function retornarParaTelaConfiguracao(
  mensagemErro?: string,
  enderecoFalho?: string,
  notificarRenderer = true,
): void {
  deveAbrirTelaInicial = true;
  podeMostrarJanelaPrincipal = true;

  destruirWebViewSemEncerrarApp();

  if (mensagemErro && notificarRenderer) {
    notificarErroConexaoSistema(mensagemErro, enderecoFalho);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.setFullScreen(true);
    mainWindow.focus();
    if (notificarRenderer) {
      enviarErroConexaoPendente();
    }
    console.log('Retornando para tela de configurações após falha de conexão');
    return;
  }

  createWindow();
}

interface CriarWebViewOpcoes {
  notificarErro?: boolean;
}

function criarWebView(
  enderecoSistema: string,
  opcoes: CriarWebViewOpcoes = {},
): Promise<boolean> {
  const notificarErro = opcoes.notificarErro !== false;
  if (webViewWindow) {
    webViewWindow.focus();
    webViewWindow.show();
    return Promise.resolve(true);
  }

  webViewWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    fullscreen: true, // Abrir em tela cheia
    autoHideMenuBar: true, // Esconder barra de menu automaticamente
    show: false, // Exibir somente após validar carregamento
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-webview.js'),
    },
  });

  // Garantir que a janela fique em fullscreen
  webViewWindow.setFullScreen(true);

  // Remover menu completamente
  webViewWindow.setMenuBarVisibility(false);

  console.log('Criando WebView com endereço:', enderecoSistema);

  // Resetar flag quando criar nova WebView
  messageChannelInicializado = false;

  let carregamentoConcluido = false;
  let falhaTratada = false;

  const tratarFalhaCarregamento = (
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || carregamentoConcluido || falhaTratada) {
      return;
    }

    if (CODIGOS_ERRO_CARREGAMENTO_IGNORAR.has(errorCode)) {
      return;
    }

    falhaTratada = true;
    const mensagem = formatarErroCarregamentoWebView(
      errorCode,
      errorDescription,
      enderecoSistema,
    );
    console.error(
      `Falha ao carregar WebView [${errorCode}] ${errorDescription} (${validatedURL})`,
    );
    retornarParaTelaConfiguracao(
      mensagem,
      enderecoSistema,
      notificarErro,
    );
  };

  webViewWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      tratarFalhaCarregamento(
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      );
    },
  );

  webViewWindow.webContents.on(
    'did-fail-provisional-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      tratarFalhaCarregamento(
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      );
    },
  );

  // Quando a página carregar completamente, inicializar o MessageChannel
  webViewWindow.webContents.on('did-finish-load', () => {
    carregamentoConcluido = true;
    // Resetar flag quando a página recarregar
    messageChannelInicializado = false;
    // Injetar ponto de venda no contexto da WebView (para pedido-lanchonete/index.js)
    injetarPontoVendaNaWebview();
    // Aguardar um pouco para garantir que o JavaScript da página foi executado
    // e que o listener window.addEventListener('message') já está registrado
    setTimeout(() => {
      // Configurar escuta de solicitação de peso PRIMEIRO (cria função global)
      configurarEscutaSolicitacaoPeso();
      // Depois inicializar MessageChannel (que usará a função global)
      inicializarMessageChannel();
      // Configurar escuta para mensagens de navegação (deve ser configurado após o carregamento)
      configurarEscutaNavegacao();
      // Configurar captura de ESC para sair do fullscreen
      configurarEscutaESC();
    }, 300); // Reduzido de 500ms para 300ms
  });

  // Prevenir que o menu apareça ao pressionar Alt
  webViewWindow.on('focus', () => {
    webViewWindow?.setMenuBarVisibility(false);
  });

  // Garantir que o fechamento da WebView também encerre o app completamente
  webViewWindow.on('close', async (event) => {
    // Se não estiver encerrando ainda, iniciar processo de limpeza
    if (!isQuitting) {
      event.preventDefault(); // Prevenir fechamento imediato
      console.log('Fechamento da WebView detectado, iniciando encerramento...');
      // Marcar que está encerrando para evitar loops
      isQuitting = true;
      // Chamar app.quit() que vai disparar before-quit e fazer a limpeza completa
      // Não chamar limparRecursosCompletamente() aqui para evitar duplicação
      app.quit();
    }
  });

  webViewWindow.on('closed', () => {
    webViewWindow = null;
    messageChannelInicializado = false;
  });

  return webViewWindow
    .loadURL(enderecoSistema)
    .then(() => {
      if (falhaTratada) {
        return false;
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
        console.log('Janela principal ocultada após WebView carregar com sucesso');
      }

      if (webViewWindow && !webViewWindow.isDestroyed()) {
        webViewWindow.show();
        webViewWindow.focus();
        console.log('WebView carregada e exibida com sucesso');
      }

      return true;
    })
    .catch((error: Error) => {
      if (!falhaTratada) {
        tratarFalhaCarregamento(
          -1,
          error.message || 'Erro ao carregar URL',
          enderecoSistema,
          true,
        );
      }
      return false;
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
  `,
    )
    .catch(() => {});

  // Verificar periodicamente de forma mais eficiente (a cada 50ms)
  const verificarSolicitacao = () => {
    // Parar verificação se o app está encerrando ou a janela foi destruída
    if (isQuitting || !webViewWindow || webViewWindow.isDestroyed()) {
      timerVerificarSolicitacao = null;
      return;
    }

    webViewWindow.webContents
      .executeJavaScript(
        `
      document.getElementById('__electron_solicitar_peso_now__') !== null
    `,
      )
      .then((existe) => {
        if (existe && !isQuitting) {
          solicitarPesoParaWebView();
        }
        // Continuar verificando apenas se não estiver encerrando
        if (!isQuitting) {
          timerVerificarSolicitacao = setTimeout(verificarSolicitacao, 50);
        } else {
          timerVerificarSolicitacao = null;
        }
      })
      .catch(() => {
        if (!isQuitting) {
          timerVerificarSolicitacao = setTimeout(verificarSolicitacao, 50);
        } else {
          timerVerificarSolicitacao = null;
        }
      });
  };

  // Iniciar verificação após um pequeno delay
  timerVerificarSolicitacao = setTimeout(verificarSolicitacao, 500);

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
  `,
    )
    .catch(() => {});
}

/**
 * Injeta o ponto de venda (persistido no electron-store) no contexto da WebView.
 * Fallback para páginas que ainda escutam electronPontoVendaReady; a fonte de verdade é window.api.getPontoVenda().
 */
function injetarPontoVendaNaWebview(): void {
  if (!webViewWindow || webViewWindow.isDestroyed()) {
    return;
  }
  const ponto = store.get('pontoVendaBalanca');
  const value =
    ponto === undefined || ponto === null || ponto === ''
      ? 'null'
      : JSON.stringify(ponto);
  const script = `
    window.__PONTO_VENDA_BALANCA__ = ${value};
    try {
      window.dispatchEvent(new CustomEvent('electronPontoVendaReady', { detail: window.__PONTO_VENDA_BALANCA__ }));
    } catch (e) {}
  `;
  webViewWindow.webContents.executeJavaScript(script).catch((err) => {
    console.error('Erro ao injetar ponto de venda na WebView:', err);
  });
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
  `,
    )
    .then(() => {
      console.log('Script de navegação injetado com sucesso');
    })
    .catch((err) => {
      console.error('Erro ao injetar script de navegação:', err);
    });

  // Verificar periodicamente se há solicitação para abrir tela inicial
  const verificarNavegacao = () => {
    // Parar verificação se o app está encerrando ou a janela foi destruída
    if (isQuitting || !webViewWindow || webViewWindow.isDestroyed()) {
      timerVerificarNavegacao = null;
      return;
    }

    webViewWindow.webContents
      .executeJavaScript(
        `
      document.getElementById('__electron_abrir_tela_inicial__') !== null
    `,
      )
      .then((existe) => {
        if (existe && !isQuitting) {
          console.log('Solicitação para abrir tela inicial detectada');
          // Definir flags para indicar que há instrução explícita de abrir tela inicial
          deveAbrirTelaInicial = true;
          podeMostrarJanelaPrincipal = true;
          // Abrir/focar janela principal
          if (mainWindow) {
            if (mainWindow.isDestroyed()) {
              console.log('Criando nova janela principal');
              createWindow();
            } else {
              console.log('Focando janela principal existente');
              mainWindow.show();
              mainWindow.setFullScreen(true);
              mainWindow.focus();
            }
          } else {
            console.log('Criando janela principal (não existe)');
            createWindow();
          }
        }
        // Continuar verificando apenas se não estiver encerrando
        if (!isQuitting) {
          timerVerificarNavegacao = setTimeout(verificarNavegacao, 100);
        } else {
          timerVerificarNavegacao = null;
        }
      })
      .catch((err) => {
        console.error('Erro ao verificar navegação:', err);
        if (!isQuitting) {
          timerVerificarNavegacao = setTimeout(verificarNavegacao, 100);
        } else {
          timerVerificarNavegacao = null;
        }
      });
  };

  // Iniciar verificação após um pequeno delay
  timerVerificarNavegacao = setTimeout(verificarNavegacao, 500);
}

// Função para configurar escuta de ESC na WebView para sair do fullscreen
function configurarEscutaESC(): void {
  if (!webViewWindow || webViewWindow.isDestroyed()) {
    return;
  }

  console.log('Configurando escuta de ESC na WebView');

  // Injetar código JavaScript para capturar ESC
  webViewWindow.webContents
    .executeJavaScript(
      `
    (function() {
      // Criar função para solicitar sair do fullscreen
      if (!window.__electronSairFullscreen) {
        window.__electronSairFullscreen = function() {
          // Criar elemento temporário que será detectado pelo processo principal
          const el = document.createElement('div');
          el.id = '__electron_sair_fullscreen__';
          el.style.display = 'none';
          document.body.appendChild(el);
          setTimeout(() => el.remove(), 50);
        };
      }
      
      // Escutar tecla ESC
      if (window.__electronESCListener) {
        document.removeEventListener('keydown', window.__electronESCListener);
      }
      
      window.__electronESCListener = function(event) {
        // Verificar se a tecla pressionada é ESC (Escape)
        if (event.key === 'Escape' || event.keyCode === 27) {
          event.preventDefault();
          event.stopPropagation();
          console.log('ESC pressionado na WebView');
          if (typeof window.__electronSairFullscreen === 'function') {
            window.__electronSairFullscreen();
          }
          return false;
        }
      };
      
      document.addEventListener('keydown', window.__electronESCListener, true);
      console.log('Escuta de ESC configurada na WebView');
    })();
  `,
    )
    .then(() => {
      console.log('Script de ESC injetado com sucesso na WebView');
    })
    .catch((err) => {
      console.error('Erro ao injetar script de ESC:', err);
    });

  // Verificar periodicamente se há solicitação para sair do fullscreen
  const verificarESC = () => {
    // Parar verificação se o app está encerrando ou a janela foi destruída
    if (isQuitting || !webViewWindow || webViewWindow.isDestroyed()) {
      timerVerificarESC = null;
      return;
    }

    webViewWindow.webContents
      .executeJavaScript(
        `
      document.getElementById('__electron_sair_fullscreen__') !== null
    `,
      )
      .then((existe) => {
        if (existe && !isQuitting) {
          console.log(
            'Solicitação para sair do fullscreen detectada na WebView',
          );
          if (webViewWindow && !webViewWindow.isDestroyed()) {
            webViewWindow.setFullScreen(false);
          }
        }
        // Continuar verificando apenas se não estiver encerrando
        if (!isQuitting) {
          timerVerificarESC = setTimeout(verificarESC, 100);
        } else {
          timerVerificarESC = null;
        }
      })
      .catch((err) => {
        console.error('Erro ao verificar ESC:', err);
        if (!isQuitting) {
          timerVerificarESC = setTimeout(verificarESC, 100);
        } else {
          timerVerificarESC = null;
        }
      });
  };

  // Iniciar verificação após um pequeno delay
  timerVerificarESC = setTimeout(verificarESC, 500);
}

// Função para solicitar peso da balança e enviar para WebView (otimizada para velocidade)
async function solicitarPesoParaWebView(): Promise<void> {
  if (!serialPort || !serialPort.isOpen) {
    console.log(
      'Conexão serial não está aberta, não é possível solicitar peso',
    );
    return;
  }

  // Reenviar cache imediatamente (poll da WebView)
  if (ultimoPesoNumericoEnviado !== null) {
    enviarPesoParaWebView(ultimoPesoNumericoEnviado);
  }

  const agora = Date.now();
  if (agora - ultimaLeituraSerialMs < INTERVALO_MIN_LEITURA_SERIAL_MS) {
    return;
  }

  if (solicitacaoPesoEmAndamento) {
    return;
  }

  solicitacaoPesoEmAndamento = true;
  ultimaLeituraSerialMs = agora;

  try {
    if (comandoFuncionando) {
      try {
        await lerPesoRapido(comandoFuncionando, TIMEOUT_LEITURA_PESO_MS);
        return;
      } catch (error: any) {
        console.log('lerPesoRapido timeout/erro:', error.message);
      }
    }

    await lerPeso(TIMEOUT_LEITURA_PESO_MS, true);
  } catch (error: any) {
    console.log('lerPeso timeout/erro:', error.message);
  } finally {
    solicitacaoPesoEmAndamento = false;
  }
}

// Função otimizada para leitura rápida usando comando conhecido
function lerPesoRapido(
  comando: string | Buffer,
  timeout: number = TIMEOUT_LEITURA_PESO_MS,
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

    const finalizarLeituraRapida = (pesoEmKg: string) => {
      pesoResolvido = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (parser) {
        parser.removeListener('data', onDataRapido);
      }
      callbackPesoRecebido = null;
      resolve(pesoEmKg);
    };

    // Listener temporário — aceita múltiplos pacotes até timeout
    const onDataRapido = (data: string | Buffer) => {
      if (pesoResolvido) return;

      let buffer: Buffer =
        typeof data === 'string' ? Buffer.from(data, 'utf8') : data;

      if (
        buffer.length >= 3 &&
        buffer[0] === 0x02 &&
        buffer[buffer.length - 1] === 0x03
      ) {
        const pesoBruto = processarRespostaToledo(buffer);
        const pesoEmKg = registrarEEnviarPesoBruto(pesoBruto, 'lerPesoRapido', {
          invocarCallback: false,
        });
        if (pesoEmKg) {
          finalizarLeituraRapida(pesoEmKg);
        }
      }
    };

    if (parser) {
      parser.on('data', onDataRapido);
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

/**
 * Fecha a conexão serial e remove todos os listeners
 * Esta função garante que a porta serial seja completamente liberada
 */
function fecharConexaoSerial(): Promise<void> {
  return new Promise((resolve) => {
    // Limpar callback de peso recebido
    callbackPesoRecebido = null;
    limparCachePeso();
    solicitacaoPesoEmAndamento = false;

    // Remover todos os listeners do parser antes de destruí-lo
    if (parser) {
      try {
        parser.removeAllListeners();
        // Remover parser do pipe se ainda estiver conectado
        if (serialPort && serialPort.isOpen) {
          parser.unpipe();
        }
      } catch (err) {
        console.error('Erro ao remover listeners do parser:', err);
      }
      parser = null;
    }

    // Fechar porta serial e remover todos os listeners
    if (serialPort) {
      try {
        // Remover todos os listeners antes de fechar
        serialPort.removeAllListeners('data');
        serialPort.removeAllListeners('error');
        serialPort.removeAllListeners('open');
        serialPort.removeAllListeners('close');

        if (serialPort.isOpen) {
          console.log('Fechando porta serial:', serialPort.path);
          serialPort.close((err) => {
            if (err) {
              console.error('Erro ao fechar porta serial:', err);
            } else {
              console.log('Porta serial fechada com sucesso');
            }
            serialPort = null;
            // Aguardar um pouco para garantir que a porta foi liberada
            setTimeout(() => resolve(), 100);
          });
        } else {
          serialPort = null;
          resolve();
        }
      } catch (err) {
        console.error('Erro ao fechar porta serial:', err);
        serialPort = null;
        resolve();
      }
    } else {
      resolve();
    }
  });
}

/**
 * Função completa de limpeza que encerra todos os recursos do aplicativo
 * Esta função garante que não haja processos zumbis após o fechamento
 */
async function limparRecursosCompletamente(): Promise<void> {
  console.log('Iniciando limpeza completa de recursos...');

  // Marcar que o app está encerrando (evita loops infinitos)
  isQuitting = true;

  // 1. Cancelar todos os timers recursivos
  if (timerVerificarSolicitacao) {
    clearTimeout(timerVerificarSolicitacao);
    timerVerificarSolicitacao = null;
    console.log('Timer verificarSolicitacao cancelado');
  }
  if (timerVerificarNavegacao) {
    clearTimeout(timerVerificarNavegacao);
    timerVerificarNavegacao = null;
    console.log('Timer verificarNavegacao cancelado');
  }
  if (timerVerificarESC) {
    clearTimeout(timerVerificarESC);
    timerVerificarESC = null;
    console.log('Timer verificarESC cancelado');
  }

  // 2. Fechar conexão serial (remove listeners e fecha porta)
  await fecharConexaoSerial();

  // 3. Remover todos os listeners IPC antes de fechar janelas
  try {
    ipcMain.removeAllListeners('listar-portas');
    ipcMain.removeAllListeners('testar-conexao');
    ipcMain.removeAllListeners('conectar-balanca');
    ipcMain.removeAllListeners('abrir-tela-inicial');
    ipcMain.removeAllListeners('sair-fullscreen');
    ipcMain.removeAllListeners('app-quit');
    console.log('Todos os listeners IPC removidos');
  } catch (err) {
    console.error('Erro ao remover listeners IPC:', err);
  }

  // 4. Fechar janela WebView se existir
  if (webViewWindow && !webViewWindow.isDestroyed()) {
    try {
      // Remover todos os listeners da WebView antes de fechar
      webViewWindow.removeAllListeners();
      webViewWindow.webContents.removeAllListeners();
      webViewWindow.close();
      console.log('WebView fechada');
    } catch (err) {
      console.error('Erro ao fechar WebView:', err);
    }
    webViewWindow = null;
  }

  // 5. Fechar janela principal se existir
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      // Remover todos os listeners da janela principal antes de fechar
      mainWindow.removeAllListeners();
      mainWindow.webContents.removeAllListeners();
      mainWindow.close();
      console.log('Janela principal fechada');
    } catch (err) {
      console.error('Erro ao fechar janela principal:', err);
    }
    mainWindow = null;
  }

  // 6. Limpar variáveis globais
  messageChannelInicializado = false;
  comandoFuncionando = null;
  deveAbrirTelaInicial = false;
  podeMostrarJanelaPrincipal = false;
  callbackPesoRecebido = null;

  console.log('Limpeza completa de recursos finalizada');
}

function abrirConexaoSerial(config: SerialConfig): Promise<void> {
  return new Promise(async (resolve, reject) => {
    // Fechar conexão anterior antes de abrir nova
    await fecharConexaoSerial();

    // Aguardar um pouco mais para garantir que a porta foi completamente liberada
    await new Promise((r) => setTimeout(r, 200));

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

    serialPort.open(async (err) => {
      if (err) {
        console.error('Erro ao abrir porta serial:', err);
        // Se for erro de acesso negado, tentar fechar novamente e aguardar mais
        if (
          err.message &&
          (err.message.includes('Access Denied') ||
            err.message.includes('EACCES'))
        ) {
          console.log(
            'Erro Access Denied detectado, tentando fechar porta novamente...',
          );
          try {
            await fecharConexaoSerial();
            // Aguardar mais tempo antes de rejeitar
            await new Promise((r) => setTimeout(r, 500));
            reject(
              new Error(
                `Porta ${config.port} está em uso ou não foi liberada corretamente. Tente novamente em alguns segundos.`,
              ),
            );
          } catch (closeErr: any) {
            reject(
              new Error(
                `Erro ao fechar porta serial: ${
                  closeErr?.message || closeErr
                }. A porta pode estar em uso.`,
              ),
            );
          }
        } else {
          reject(err);
        }
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
            '\n==============================',
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
          '\n==========================================',
        );

        // Processar resposta Toledo imediatamente se estiver no formato STX...ETX
        if (
          data.length >= 3 &&
          data[0] === 0x02 &&
          data[data.length - 1] === 0x03
        ) {
          const pesoBruto = processarRespostaToledo(data);
          if (pesoBruto) {
            registrarEEnviarPesoBruto(pesoBruto, 'serial-direto');
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
          Buffer.from(pesoBruto, 'utf8').toString('hex'),
        );

        registrarEEnviarPesoBruto(pesoBruto, 'parser');
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
      '\n======================',
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
// Entrada: string com dígitos (ex: "00415", "ST,GS, 00415 kg", ";0260", "-0.101", etc.)
// Saída: número inteiro em gramas/milésimos de kg (ex: 415, -101) ou null se inválido
function extrairValorNumericoBruto(pesoBruto: string): number | null {
  if (!pesoBruto || typeof pesoBruto !== 'string') {
    return null;
  }

  const texto = pesoBruto.trim();
  if (!texto) {
    return null;
  }

  // Toledo: ';' ou '-' indicam valores negativos — no início ou antes dos dígitos do peso
  const negativo =
    /^[;-]/.test(texto) ||
    /[;,]\s*[;-]/.test(texto) ||
    /;\s*\d/.test(texto);

  // Formato decimal como no visor (ex: -0.101, 12.345, 0.101)
  const matchDecimal = texto.match(/(\d+)[.,](\d+)/);
  if (matchDecimal) {
    const valorDecimal = parseFloat(
      `${matchDecimal[1]}.${matchDecimal[2]}`,
    );
    if (!isNaN(valorDecimal)) {
      const valorInteiro = Math.round(valorDecimal * 1000) * (negativo ? -1 : 1);
      if (Math.abs(valorInteiro) <= 999999) {
        return valorInteiro;
      }
      return null;
    }
  }

  // Formato inteiro sem separador decimal (ex: "00415", ";0101", "-0101")
  const matchDigitos = texto.match(/\d+/);
  if (!matchDigitos || matchDigitos[0].length === 0) {
    return null;
  }

  let valorNumerico = parseInt(matchDigitos[0], 10);
  if (isNaN(valorNumerico)) {
    return null;
  }

  if (negativo) {
    valorNumerico = -valorNumerico;
  }

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
    `Conversão: "${pesoBruto}" -> ${valorNumerico} -> ${pesoEmKg} kg -> "${pesoFormatado}" kg`,
  );

  return pesoFormatado;
}

function limparCachePeso(): void {
  ultimoPesoNumericoEnviado = null;
  ultimoPesoBrutoRecebido = null;
  ultimoPesoEmKg = null;
  ultimoPesoEnviadoWebViewValor = null;
  ultimoPesoEnviadoWebViewMs = 0;
  ultimaLeituraSerialMs = 0;
}

function isRespostaStatusErro(pesoBruto: string): boolean {
  return /^[Nn]+$/.test(pesoBruto) || /^[Ee]+$/.test(pesoBruto);
}

function registrarEEnviarPesoBruto(
  pesoBruto: string,
  origem: string,
  options: { invocarCallback?: boolean } = {},
): string | null {
  const { invocarCallback = true } = options;

  if (!pesoBruto || pesoBruto.trim().length === 0) {
    return null;
  }

  if (isRespostaStatusErro(pesoBruto)) {
    console.log(
      `Resposta de status/erro (${origem}): "${pesoBruto}" - balança instável.`,
    );
    return null;
  }

  const pesoNumerico = extrairValorNumericoBruto(pesoBruto);
  const pesoEmKg = converterPesoParaQuilogramas(pesoBruto);

  if (pesoEmKg === null || pesoNumerico === null) {
    console.log(`Peso inválido (${origem}):`, pesoBruto);
    return null;
  }

  if (
    ultimoPesoNumericoEnviado === pesoNumerico &&
    ultimoPesoBrutoRecebido === pesoBruto
  ) {
    if (invocarCallback && callbackPesoRecebido) {
      callbackPesoRecebido(pesoEmKg);
      callbackPesoRecebido = null;
    }
    return pesoEmKg;
  }

  ultimoPesoBrutoRecebido = pesoBruto;
  ultimoPesoEmKg = pesoEmKg;
  ultimoPesoNumericoEnviado = pesoNumerico;

  console.log(
    `Peso processado (${origem}): ${pesoEmKg} kg (raw: ${pesoNumerico})`,
  );

  mainWindow?.webContents.send('peso-balanca', pesoEmKg);
  enviarPesoParaWebView(pesoNumerico);

  if (invocarCallback && callbackPesoRecebido) {
    callbackPesoRecebido(pesoEmKg);
    callbackPesoRecebido = null;
  }

  return pesoEmKg;
}

// Função para enviar peso para a WebView via postMessage
// O formato deve ser compatível com o listener: window.addEventListener('message', ...)
function enviarPesoParaWebView(pesoNumerico: number): void {
  if (!webViewWindow || webViewWindow.isDestroyed()) {
    return;
  }

  const agora = Date.now();
  if (
    ultimoPesoEnviadoWebViewValor === pesoNumerico &&
    agora - ultimoPesoEnviadoWebViewMs < DEDUPE_ENVIO_PESO_MS
  ) {
    return;
  }

  ultimoPesoNumericoEnviado = pesoNumerico;
  ultimoPesoEnviadoWebViewValor = pesoNumerico;
  ultimoPesoEnviadoWebViewMs = agora;

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
      err.message,
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
  maxTentativas: number = 3,
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
          'Nenhum dado recebido em modo contínuo, tentando comandos...',
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
            pesoConvertido,
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
          'kg',
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
          const pesoEmKg = registrarEEnviarPesoBruto(
            pesoBruto,
            'lerPeso-continuo',
            { invocarCallback: false },
          );
          if (!pesoEmKg) {
            return;
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
          const pesoEmKg = registrarEEnviarPesoBruto(
            pesoBruto,
            'lerPeso-continuo-alt',
            { invocarCallback: false },
          );
          if (!pesoEmKg) {
            return;
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
            'kg',
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
              `Resposta recebida após comando ${i}, interrompendo tentativas adicionais.`,
            );
            // Salvar comando que funcionou
            if (i > 0 && comandosParaTentar[i - 1]) {
              comandoFuncionando = comandosParaTentar[i - 1];
              console.log(
                'Comando funcionando salvo em cache para leituras rápidas',
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
            }: Enviando comando ${cmdDesc}`,
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
                }, interrompendo tentativas adicionais.`,
              );
              // Salvar comando que funcionou
              comandoFuncionando = cmd;
              console.log(
                'Comando funcionando salvo em cache para leituras rápidas',
              );
              break;
            }
          } catch (err) {
            console.log(`Erro ao enviar comando ${i + 1}:`, err);
          }
        }

        if (pesoResolvido || dadosRecebidosModoContinuo) {
          console.log(
            'Resposta recebida com sucesso, não é necessário aguardar mais comandos.',
          );
        } else {
          console.log('Todos os comandos enviados, aguardando resposta...');
        }
      } catch (err) {
        console.log(
          'Erro ao enviar comandos Toledo (continuando mesmo assim):',
          err,
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
          '  3. A porta COM está correta (verifique no Gerenciador de Dispositivos)',
        );
        console.log('  4. A balança está configurada para comunicação serial');
        console.log('     - Acesse o menu da balança');
        console.log('     - Procure por "Comunicação Serial" ou "RS232"');
        console.log(
          '     - Configure o protocolo (Prt1, TOLEDO Continuous, etc.)',
        );
        console.log(
          '  5. Os parâmetros de comunicação na balança correspondem:',
        );
        console.log('     - Baud Rate: 9600');
        console.log('     - Data Bits: 8');
        console.log('     - Parity: None');
        console.log('     - Stop Bits: 1');
        console.log('  6. Nenhum outro programa está usando a porta COM');
        console.log('');
        console.log(
          'Se a balança envia dados automaticamente (modo contínuo),',
        );
        console.log('certifique-se de que essa opção está habilitada no menu.');
        console.log('');
        reject(
          new Error(
            'Timeout: Nenhum dado recebido da balança. Verifique se a balança está ligada e configurada corretamente.',
          ),
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

      const pesoEmKg = registrarEEnviarPesoBruto(pesoBruto, 'lerPeso-onData', {
        invocarCallback: false,
      });

      if (!pesoEmKg) {
        return;
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

// Interface para os dados salvos no localStorage
interface SavedConfig {
  enderecoSistema: string;
  portaSerial: string;
  baudRate: string;
  dataBits: string;
  parity: string;
  stopBits: string;
}

// Função para verificar se os dados obrigatórios estão preenchidos
function verificarDadosObrigatoriosPreenchidos(
  config: SavedConfig | null,
): boolean {
  if (!config) {
    return false;
  }

  // Verificar se todos os campos obrigatórios estão preenchidos
  const camposObrigatorios = [
    config.enderecoSistema,
    config.portaSerial,
    config.baudRate,
    config.dataBits,
    config.parity,
    config.stopBits,
  ];

  // Verificar se todos os campos estão preenchidos e não são strings vazias
  const todosPreenchidos = camposObrigatorios.every(
    (campo) => campo && campo.trim().length > 0,
  );

  // Verificar se o endereço do sistema é válido (deve começar com http:// ou https://)
  const enderecoValido =
    !!config.enderecoSistema &&
    (config.enderecoSistema.startsWith('http://') ||
      config.enderecoSistema.startsWith('https://'));

  return todosPreenchidos && enderecoValido;
}

// Função para obter configuração salva do renderer
async function obterConfiguracaoSalva(): Promise<SavedConfig | null> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  try {
    // Aguardar um pouco para garantir que o DOM e localStorage estejam prontos
    await new Promise((resolve) => setTimeout(resolve, 200));

    const config = await mainWindow.webContents.executeJavaScript(`
      (function() {
        try {
          const saved = localStorage.getItem('balanca_config');
          if (saved) {
            const parsed = JSON.parse(saved);
            console.log('Configuração obtida do localStorage:', parsed);
            return parsed;
          }
        } catch (error) {
          console.error('Erro ao carregar configuração:', error);
        }
        return null;
      })();
    `);
    return config;
  } catch (error) {
    console.error('Erro ao obter configuração salva:', error);
    return null;
  }
}

// Função para verificar e redirecionar automaticamente para WebView
// Retorna true se redirecionou, false caso contrário
async function verificarERedirecionarAutomaticamente(): Promise<boolean> {
  // Não redirecionar se houver instrução explícita de abrir tela inicial
  if (deveAbrirTelaInicial) {
    console.log(
      'Instrução explícita de abrir tela inicial detectada em verificarERedirecionarAutomaticamente, não redirecionando automaticamente',
    );
    // NÃO resetar a flag aqui, pois ela será usada no did-finish-load
    return false;
  }

  // Obter configuração salva
  const config = await obterConfiguracaoSalva();

  // Verificar se existe endereço do sistema salvo
  if (!config || !config.enderecoSistema) {
    console.log(
      'Nenhum endereço do sistema salvo encontrado, não redirecionando',
    );
    return false;
  }

  // Verificar se todos os dados obrigatórios estão preenchidos
  if (!verificarDadosObrigatoriosPreenchidos(config)) {
    console.log(
      'Dados obrigatórios não estão completamente preenchidos, não redirecionando',
    );
    return false;
  }

  console.log(
    'Configuração válida encontrada, redirecionando automaticamente para WebView...',
  );

  const validacaoUrl = await validarUrlAcessivel(config.enderecoSistema);
  if (!validacaoUrl.acessivel) {
    console.warn(
      'Endereço do sistema inacessível, permanecendo na tela de configurações:',
      validacaoUrl.erro,
    );
    podeMostrarJanelaPrincipal = true;
    deveAbrirTelaInicial = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.setFullScreen(true);
      mainWindow.focus();
      notificarErroConexaoSistema(
        validacaoUrl.erro ||
          formatarMensagemErroConexao(config.enderecoSistema),
        config.enderecoSistema,
      );
      enviarErroConexaoPendente();
    }
    return false;
  }

  // Converter configuração para SerialConfig
  const serialConfig: SerialConfig = {
    port: config.portaSerial,
    baudRate: parseInt(config.baudRate),
    dataBits: parseInt(config.dataBits) as 7 | 8,
    parity: config.parity as 'none' | 'even' | 'odd',
    stopBits: parseInt(config.stopBits) as 1 | 2,
  };

  try {
    // Abrir conexão serial
    await abrirConexaoSerial(serialConfig);

    // Criar WebView
    const webViewAberta = await criarWebView(config.enderecoSistema);
    if (!webViewAberta) {
      console.warn(
        'Falha ao carregar WebView, retornando para tela de configurações',
      );
      return false;
    }

    console.log('WebView criada e exibida com sucesso');
    return true; // Redirecionou com sucesso
  } catch (error: any) {
    console.error('Erro ao redirecionar automaticamente:', error);
    // Se houver erro, mostrar a janela principal novamente
    podeMostrarJanelaPrincipal = true;
    deveAbrirTelaInicial = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    // Não fechar conexão serial aqui, pois pode não ter sido aberta
    return false;
  }
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

    await fecharConexaoSerial();
    return { sucesso: true, peso };
  } catch (error: any) {
    console.error('Erro ao testar conexão:', error);
    await fecharConexaoSerial();
    return {
      sucesso: false,
      erro: error.message || 'Erro desconhecido ao testar conexão',
    };
  }
});

/** Resposta da API pontos-lanchonete */
interface PontoLanchoneteItem {
  ponto_venda_id: string;
  nome: string;
  ordem?: string;
  data_excluido?: string | null;
  ponto_impressao_id?: string;
  pedido_lanchonete?: string;
}

ipcMain.handle(
  'buscar-pontos-lanchonete',
  async (_: unknown, baseUrl: string): Promise<PontoLanchoneteItem[]> => {
    const url = baseUrl.replace(/\/+$/, '') + '/index/pontos-lanchonete';
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      TIMEOUT_VALIDACAO_URL_MS,
    );

    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } finally {
      clearTimeout(timeoutId);
    }
  },
);

ipcMain.handle('get-ponto-venda', async (): Promise<string | null> => {
  const value = store.get('pontoVendaBalanca');
  return value === undefined || value === '' ? null : value;
});

ipcMain.handle(
  'set-ponto-venda',
  async (
    _: unknown,
    pontoVendaId: string | null | undefined,
  ): Promise<void> => {
    const value =
      pontoVendaId !== undefined && pontoVendaId !== null && pontoVendaId !== ''
        ? pontoVendaId
        : null;
    store.set('pontoVendaBalanca', value);
  },
);

ipcMain.handle(
  'conectar-balanca',
  async (
    _,
    config: SerialConfig,
    enderecoSistema: string,
    pontoVenda?: string,
  ) => {
    try {
      // Validar endereço do sistema
      if (!enderecoSistema || !enderecoSistema.startsWith('http')) {
        return {
          sucesso: false,
          erro: 'Endereço do sistema inválido. Deve começar com http:// ou https://',
        };
      }

      // Persistir ponto de venda no electron-store (pedido-lanchonete e próxima abertura)
      store.set(
        'pontoVendaBalanca',
        pontoVenda !== undefined && pontoVenda !== '' ? pontoVenda : null,
      );

      const validacaoUrl = await validarUrlAcessivel(enderecoSistema);
      if (!validacaoUrl.acessivel) {
        return {
          sucesso: false,
          erro:
            validacaoUrl.erro ||
            formatarMensagemErroConexao(enderecoSistema),
        };
      }

      // Abrir conexão serial
      await abrirConexaoSerial(config);

      // Criar WebView
      const webViewAberta = await criarWebView(enderecoSistema, {
        notificarErro: false,
      });
      if (!webViewAberta) {
        await fecharConexaoSerial();
        return {
          sucesso: false,
          erro: formatarMensagemErroConexao(enderecoSistema),
        };
      }

      // Ocultar a janela principal após conectar com sucesso
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }

      return { sucesso: true };
    } catch (error: any) {
      await fecharConexaoSerial();
      return {
        sucesso: false,
        erro: error.message || 'Erro ao conectar balança',
      };
    }
  },
);

// Handler para focar/abrir a janela principal quando solicitado da WebView
ipcMain.handle('abrir-tela-inicial', async () => {
  try {
    // Definir flags para indicar que há instrução explícita de abrir tela inicial
    deveAbrirTelaInicial = true;
    podeMostrarJanelaPrincipal = true;
    console.log(
      'Handler abrir-tela-inicial chamado, definindo flags para permitir exibição',
    );

    if (mainWindow) {
      if (mainWindow.isDestroyed()) {
        createWindow();
      } else {
        // Garantir fullscreen e sem menu
        mainWindow.setFullScreen(true);
        mainWindow.setMenuBarVisibility(false);
        mainWindow.show();
        mainWindow.focus();
        console.log('Janela principal exibida via handler');
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

// Handler para sair do modo fullscreen
ipcMain.handle('sair-fullscreen', async () => {
  try {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.setFullScreen(false);
      return { sucesso: true };
    }
    return { sucesso: false, erro: 'Nenhuma janela focada' };
  } catch (error: any) {
    console.error('Erro ao sair do fullscreen:', error);
    return { sucesso: false, erro: error.message };
  }
});

/**
 * Handler IPC para permitir que o renderer solicite o fechamento do app
 * Isso garante que window.close() no renderer acione app.quit() no main process
 */
ipcMain.handle('app-quit', async () => {
  try {
    console.log('Fechamento solicitado via IPC do renderer');
    await limparRecursosCompletamente();
    app.quit();
    return { sucesso: true };
  } catch (error: any) {
    console.error('Erro ao encerrar app via IPC:', error);
    // Mesmo com erro, tentar encerrar o app
    app.quit();
    return { sucesso: false, erro: error.message };
  }
});

if (gotTheLock) {
  app.on('second-instance', () => {
    focusExistingApplicationWindow();
  });

  app.whenReady().then(() => {
    // Remover completamente o menu da aplicação
    Menu.setApplicationMenu(null);

    createWindow();

    /**
     * Evento window-all-closed: disparado quando todas as janelas são fechadas
     * IMPORTANTE: No macOS, o comportamento padrão é manter o app ativo após fechar janelas
     * Vamos sobrescrever isso para garantir encerramento completo em todas as plataformas
     */
    app.on('window-all-closed', async () => {
      console.log('Todas as janelas foram fechadas');
      // Limpar recursos antes de encerrar
      await limparRecursosCompletamente();

      // No macOS, o comportamento padrão é manter o app ativo após fechar janelas
      // Vamos sobrescrever isso para garantir encerramento completo
      // Isso evita processos zumbis no Monitor de Atividade
      app.quit();
    });

    /**
     * Evento activate: disparado quando o app é ativado (macOS)
     * Recria janela se não houver nenhuma aberta
     */
    app.on('activate', () => {
      // Só recriar janela se não estiver encerrando
      if (!isQuitting && BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });

    // Prevenir que o menu apareça - os listeners individuais nas janelas já cuidam disso
  });

  /**
   * Evento before-quit: disparado ANTES do app encerrar
   * Este é o lugar ideal para garantir limpeza completa de recursos
   * IMPORTANTE: Usar app.quit() ao invés de app.exit() para garantir encerramento correto
   */
  app.on('before-quit', async (event) => {
    // Se já estiver encerrando, não fazer nada
    if (isQuitting) {
      return;
    }

    console.log('Evento before-quit disparado, iniciando limpeza completa...');

    // Prevenir saída imediata para garantir que todos os recursos sejam limpos
    event.preventDefault();

    // Limpar todos os recursos
    await limparRecursosCompletamente();

    // Aguardar um pouco para garantir que tudo foi fechado completamente
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Usar app.quit() ao invés de app.exit(0) para garantir encerramento correto
    // app.quit() respeita o ciclo de vida do Electron e garante que todos os processos sejam encerrados
    app.quit();
  });

  /**
   * Evento will-quit: disparado quando o app está prestes a encerrar
   * Última chance de fazer limpeza antes do encerramento definitivo
   */
  app.on('will-quit', (event) => {
    console.log('Evento will-quit disparado');
    // Garantir que isQuitting está marcado
    isQuitting = true;
  });

  /**
   * Evento quit: disparado quando o app encerra
   * Útil para logging, mas não deve fazer operações assíncronas aqui
   */
  app.on('quit', () => {
    console.log('App encerrado completamente');
    // Forçar saída do processo principal após um timeout de segurança
    // Isso garante que mesmo se algo der errado, o processo será encerrado
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });
}
