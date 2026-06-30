import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import type { UpdaterUiPayload } from './updater.types';

export type { UpdaterUiPayload } from './updater.types';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let checkInterval: ReturnType<typeof setInterval> | null = null;
let ipcRegistered = false;

function formatUpdaterError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes('net::') || error.message.includes('ENOTFOUND')) {
      return 'Sem conexão com o servidor de atualizações. Tente novamente mais tarde.';
    }
    return error.message;
  }
  return 'Erro desconhecido ao verificar atualizações.';
}

function sendToRenderer(
  getWindow: () => BrowserWindow | null,
  payload: UpdaterUiPayload,
): void {
  const window = getWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send('updater:event', payload);
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) {
    log.info('[updater] Modo desenvolvimento — auto-update desativado');
    return;
  }

  log.transports.file.level = 'info';
  log.info('[updater] Auto-update inicializado');

  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] Verificando atualizações...');
    sendToRenderer(getWindow, { type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    log.info('[updater] Atualização disponível:', info.version);
    sendToRenderer(getWindow, { type: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('[updater] Nenhuma atualização. Versão atual:', info.version);
    sendToRenderer(getWindow, { type: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    log.info('[updater] Download:', percent + '%');
    sendToRenderer(getWindow, { type: 'progress', percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[updater] Download concluído:', info.version);
    sendToRenderer(getWindow, { type: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (error) => {
    const message = formatUpdaterError(error);
    log.error('[updater] Erro:', error);
    sendToRenderer(getWindow, { type: 'error', message });
  });

  registerUpdaterIpc();

  // Aguardar o renderer registrar listeners antes da primeira verificação
  setTimeout(() => {
    void checkForUpdates();
    checkInterval = setInterval(() => {
      void checkForUpdates();
    }, CHECK_INTERVAL_MS);
  }, 5000);
}

function registerUpdaterIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('updater-download', async () => {
    if (!app.isPackaged) return { sucesso: false, erro: 'Disponível apenas em produção' };
    try {
      await autoUpdater.downloadUpdate();
      return { sucesso: true };
    } catch (error) {
      const erro = formatUpdaterError(error);
      log.error('[updater] Falha no download:', error);
      return { sucesso: false, erro };
    }
  });

  ipcMain.handle('updater-install', () => {
    if (!app.isPackaged) return { sucesso: false, erro: 'Disponível apenas em produção' };
    log.info('[updater] Reiniciando para instalar atualização...');
    autoUpdater.quitAndInstall();
    return { sucesso: true };
  });

  ipcMain.handle('updater-check-now', async () => {
    if (!app.isPackaged) return { sucesso: false, erro: 'Disponível apenas em produção' };
    try {
      await checkForUpdates();
      return { sucesso: true };
    } catch (error) {
      return { sucesso: false, erro: formatUpdaterError(error) };
    }
  });
}

async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return;
  await autoUpdater.checkForUpdates();
}

export function disposeAutoUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
