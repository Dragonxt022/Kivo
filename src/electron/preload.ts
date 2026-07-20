import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('kivo', {
  version: '0.1.0',
});
