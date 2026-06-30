import { contextBridge, ipcRenderer } from 'electron';
import type { UpdaterUiPayload } from './updater/updater.types';

export interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: 7 | 8;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
}

contextBridge.exposeInMainWorld('balanca', {
  // Listar portas seriais disponíveis
  listarPortas: () => ipcRenderer.invoke('listar-portas'),

  // Testar conexão com a balança
  testarConexao: (config: SerialConfig) =>
    ipcRenderer.invoke('testar-conexao', config),

  // Conectar definitivamente e abrir WebView (pontoVenda é injetado na WebView para pedido-lanchonete)
  conectar: (
    config: SerialConfig,
    enderecoSistema: string,
    pontoVenda?: string
  ) =>
    ipcRenderer.invoke('conectar-balanca', config, enderecoSistema, pontoVenda),

  // Escutar peso da balança
  onPeso: (callback: (peso: string) => void) => {
    ipcRenderer.on('peso-balanca', (_, peso: string) => {
      callback(peso);
    });
  },

  // Remover listener de peso
  removerListenerPeso: () => {
    ipcRenderer.removeAllListeners('peso-balanca');
  },

  // Sair do modo fullscreen
  sairFullscreen: () => ipcRenderer.invoke('sair-fullscreen'),

  // Fechar aplicativo completamente (garante limpeza de todos os recursos)
  // Esta função deve ser usada ao invés de window.close() para garantir
  // que todos os processos sejam encerrados corretamente
  fecharApp: () => ipcRenderer.invoke('app-quit'),

  // Buscar pontos de venda (lanchonete) a partir do endereço do sistema
  buscarPontosLanchonete: (baseUrl: string) =>
    ipcRenderer.invoke('buscar-pontos-lanchonete', baseUrl),

  // Ponto de venda persistido (electron-store) – leitura/escrita
  getPontoVenda: () => ipcRenderer.invoke('get-ponto-venda'),
  setPontoVenda: (pontoVendaId: string | null) =>
    ipcRenderer.invoke('set-ponto-venda', pontoVendaId),

  getVersion: () => ipcRenderer.invoke('get-app-version') as Promise<string>,

  onUpdaterEvent: (callback: (payload: UpdaterUiPayload) => void) => {
    ipcRenderer.on('updater:event', (_event, payload: UpdaterUiPayload) =>
      callback(payload),
    );
  },
  downloadUpdate: () =>
    ipcRenderer.invoke('updater-download') as Promise<{
      sucesso: boolean;
      erro?: string;
    }>,
  installUpdate: () =>
    ipcRenderer.invoke('updater-install') as Promise<{
      sucesso: boolean;
      erro?: string;
    }>,
  checkForUpdates: () =>
    ipcRenderer.invoke('updater-check-now') as Promise<{
      sucesso: boolean;
      erro?: string;
    }>,

  // Notificação de falha ao conectar ao endereço do sistema
  onErroConexaoSistema: (
    callback: (payload: { mensagem: string; endereco?: string }) => void,
  ) => {
    ipcRenderer.on(
      'erro-conexao-sistema',
      (_event, payload: { mensagem: string; endereco?: string }) => {
        callback(payload);
      },
    );
  },
});
