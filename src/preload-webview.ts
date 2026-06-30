import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  getPontoVenda: (): Promise<string | null> =>
    ipcRenderer.invoke('get-ponto-venda'),
  setPontoVenda: (pontoVendaId: string | null): Promise<void> =>
    ipcRenderer.invoke('set-ponto-venda', pontoVendaId),
  fecharApp: (): Promise<{ sucesso: boolean; erro?: string }> =>
    ipcRenderer.invoke('app-quit'),
});
