declare global {
  interface Window {
    balanca: {
      listarPortas: () => Promise<
        Array<{ path: string; manufacturer: string }>
      >;
      testarConexao: (
        config: SerialConfig
      ) => Promise<{ sucesso: boolean; peso?: string; erro?: string }>;
      conectar: (
        config: SerialConfig,
        enderecoSistema: string
      ) => Promise<{ sucesso: boolean; erro?: string }>;
      onPeso: (callback: (peso: string) => void) => void;
      removerListenerPeso: () => void;
    };
  }

  interface SerialConfig {
    port: string;
    baudRate: number;
    dataBits: 7 | 8;
    parity: 'none' | 'even' | 'odd';
    stopBits: 1 | 2;
  }
}

// Elementos do formulário
const form = document.getElementById('configForm') as HTMLFormElement;
const portaSerialSelect = document.getElementById(
  'portaSerial'
) as HTMLSelectElement;
const btnAtualizarPortas = document.getElementById(
  'btnAtualizarPortas'
) as HTMLButtonElement;
const btnTestar = document.getElementById('btnTestar') as HTMLButtonElement;
const btnConectar = document.getElementById('btnConectar') as HTMLButtonElement;
const statusMessage = document.getElementById(
  'statusMessage'
) as HTMLDivElement;

// Função para exibir mensagem de status
function mostrarMensagem(texto: string, tipo: 'success' | 'error' | 'info') {
  statusMessage.textContent = texto;
  statusMessage.className = `status-message show ${tipo}`;

  setTimeout(() => {
    statusMessage.classList.remove('show');
  }, 5000);
}

// Função para obter configuração do formulário
function obterConfiguracao(): SerialConfig | null {
  const porta = portaSerialSelect.value;
  const baudRate = parseInt(
    (document.getElementById('baudRate') as HTMLSelectElement).value
  );
  const dataBits = parseInt(
    (document.getElementById('dataBits') as HTMLSelectElement).value
  ) as 7 | 8;
  const parity = (document.getElementById('parity') as HTMLSelectElement)
    .value as 'none' | 'even' | 'odd';
  const stopBits = parseInt(
    (document.getElementById('stopBits') as HTMLSelectElement).value
  ) as 1 | 2;

  if (!porta) {
    mostrarMensagem('Por favor, selecione uma porta serial', 'error');
    return null;
  }

  return {
    port: porta,
    baudRate,
    dataBits,
    parity,
    stopBits,
  };
}

// Função para carregar portas seriais
async function carregarPortas() {
  try {
    portaSerialSelect.disabled = true;
    portaSerialSelect.innerHTML =
      '<option value="">Carregando portas...</option>';

    const portas = await window.balanca.listarPortas();

    if (portas.length === 0) {
      portaSerialSelect.innerHTML =
        '<option value="">Nenhuma porta encontrada</option>';
      mostrarMensagem(
        'Nenhuma porta serial encontrada. Verifique se há dispositivos conectados.',
        'info'
      );
      return;
    }

    portaSerialSelect.innerHTML =
      '<option value="">Selecione uma porta</option>';
    portas.forEach((porta) => {
      const option = document.createElement('option');
      option.value = porta.path;
      option.textContent = `${porta.path}${
        porta.manufacturer ? ` (${porta.manufacturer})` : ''
      }`;
      portaSerialSelect.appendChild(option);
    });

    mostrarMensagem(`${portas.length} porta(s) encontrada(s)`, 'success');
  } catch (error: any) {
    portaSerialSelect.innerHTML =
      '<option value="">Erro ao carregar portas</option>';
    mostrarMensagem(`Erro ao listar portas: ${error.message}`, 'error');
  } finally {
    portaSerialSelect.disabled = false;
  }
}

// Event listeners
btnAtualizarPortas.addEventListener('click', carregarPortas);

btnTestar.addEventListener('click', async () => {
  const config = obterConfiguracao();
  if (!config) return;

  btnTestar.disabled = true;
  btnTestar.textContent = 'Testando...';

  mostrarMensagem('Testando conexão com a balança...', 'info');

  try {
    const resultado = await window.balanca.testarConexao(config);

    if (resultado.sucesso && resultado.peso) {
      alert(
        `Conexão com a balança realizada com sucesso.\n\nPeso atual na balança: ${resultado.peso}`
      );
      mostrarMensagem('Teste realizado com sucesso!', 'success');
    } else {
      const erro = resultado.erro || 'Erro desconhecido';
      alert(`Erro ao testar conexão:\n\n${erro}`);
      mostrarMensagem(`Erro: ${erro}`, 'error');
    }
  } catch (error: any) {
    alert(`Erro ao testar conexão:\n\n${error.message}`);
    mostrarMensagem(`Erro: ${error.message}`, 'error');
  } finally {
    btnTestar.disabled = false;
    btnTestar.textContent = 'Testar Conexão';
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const enderecoSistema = (
    document.getElementById('enderecoSistema') as HTMLInputElement
  ).value.trim();

  if (!enderecoSistema) {
    mostrarMensagem('Por favor, informe o endereço do sistema', 'error');
    return;
  }

  if (
    !enderecoSistema.startsWith('http://') &&
    !enderecoSistema.startsWith('https://')
  ) {
    mostrarMensagem(
      'O endereço do sistema deve começar com http:// ou https://',
      'error'
    );
    return;
  }

  const config = obterConfiguracao();
  if (!config) return;

  btnConectar.disabled = true;
  btnConectar.textContent = 'Conectando...';

  mostrarMensagem('Conectando à balança e abrindo sistema...', 'info');

  try {
    const resultado = await window.balanca.conectar(config, enderecoSistema);

    if (resultado.sucesso) {
      mostrarMensagem(
        'Conectado com sucesso! A WebView será aberta em breve.',
        'success'
      );
      // Opcionalmente, podemos fechar a janela de configuração após alguns segundos
      // setTimeout(() => window.close(), 2000);
    } else {
      const erro = resultado.erro || 'Erro desconhecido';
      alert(`Erro ao conectar:\n\n${erro}`);
      mostrarMensagem(`Erro: ${erro}`, 'error');
    }
  } catch (error: any) {
    alert(`Erro ao conectar:\n\n${error.message}`);
    mostrarMensagem(`Erro: ${error.message}`, 'error');
  } finally {
    btnConectar.disabled = false;
    btnConectar.textContent = 'Conectar';
  }
});

// Carregar portas ao iniciar
carregarPortas();

export {};
