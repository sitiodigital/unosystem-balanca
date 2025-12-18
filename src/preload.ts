import { contextBridge, ipcRenderer } from 'electron';

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

  // Conectar definitivamente e abrir WebView
  conectar: (config: SerialConfig, enderecoSistema: string) =>
    ipcRenderer.invoke('conectar-balanca', config, enderecoSistema),

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
});
