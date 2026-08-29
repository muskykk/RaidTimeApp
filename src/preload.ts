import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data: unknown) => ipcRenderer.invoke('data:save', data),
  getLoginItemStatus: () => ipcRenderer.invoke('settings:getLoginItemStatus'),
});
