const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cadence', {
  // State
  getState: () => ipcRenderer.invoke('get-state'),

  // Settings
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', key),

  // DAG loading
  openDagFile: () => ipcRenderer.invoke('open-dag-file'),

  // Browser control
  navigate: (url) => ipcRenderer.invoke('navigate', url),

  // Query
  query: (q) => ipcRenderer.invoke('query', q),

  // Event listeners (main → renderer pushes)
  onUrlChanged:    (cb) => ipcRenderer.on('url-changed',    (_, data) => cb(data)),
  onStepProgress:  (cb) => ipcRenderer.on('step-progress',  (_, data) => cb(data)),
  onStepDone:      (cb) => ipcRenderer.on('step-done',      (_, data) => cb(data)),
  onStepError:     (cb) => ipcRenderer.on('step-error',     (_, data) => cb(data)),
});
