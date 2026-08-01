import { contextBridge, ipcRenderer } from 'electron';
import type { RailApi } from './rail-api';

const rail: RailApi = {
  onState: (cb) => {
    ipcRenderer.on('rail:state', (_e, s) => cb(s));
  },
  back: () => ipcRenderer.send('rail:back'),
  disconnect: () => ipcRenderer.send('rail:disconnect'),
  control: (action) => ipcRenderer.send(`win:${action}`),
};
contextBridge.exposeInMainWorld('rail', rail);
