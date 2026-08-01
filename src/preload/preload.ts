import { contextBridge, ipcRenderer } from 'electron';
import type { GlkvmApi } from './api';

const api: GlkvmApi = {
  listDevices: () => ipcRenderer.invoke('devices:list'),
  addDevice: (input) => ipcRenderer.invoke('devices:add', input),
  updateDevice: (id, patch) => ipcRenderer.invoke('devices:update', id, patch),
  removeDevice: (id) => ipcRenderer.invoke('devices:remove', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (next) => ipcRenderer.invoke('settings:set', next),
  connect: (id) => ipcRenderer.invoke('conn:connect', id),
  disconnect: () => ipcRenderer.invoke('conn:disconnect'),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  onConnectionState: (cb) => { ipcRenderer.on('conn:state', (_e, s) => cb(s)); },
  onConnectedDevices: (cb) => { ipcRenderer.on('devices:connected', (_e, ids) => cb(ids)); },
  onNavigate: (cb) => { ipcRenderer.on('nav:view', (_e, v) => cb(v)); },
  onModalShow: (cb) => { ipcRenderer.on('modal:show', (_e, spec) => cb(spec)); },
  modalDone: (id, value) => { ipcRenderer.send('modal:done', { id, value }); },
};
contextBridge.exposeInMainWorld('glkvm', api);
