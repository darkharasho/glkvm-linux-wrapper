import { contextBridge } from 'electron';
// Expanded in Task 7. Placeholder bridge proves the wiring.
contextBridge.exposeInMainWorld('glkvm', { version: '0.1.0' });
