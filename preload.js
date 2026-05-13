/**
 * Preload — expone API segura al renderer (contextBridge).
 * Sin nodeIntegration; el renderer no toca fs ni la API key directo.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phantom', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (cfg) => ipcRenderer.invoke('config:set', cfg)
  },
  window: {
    hide: () => ipcRenderer.invoke('window:hide'),
    show: () => ipcRenderer.invoke('window:show'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close'),
    setContentProtection: (on) => ipcRenderer.invoke('window:set-content-protection', on),
    setOpacity: (value) => ipcRenderer.invoke('window:set-opacity', value),
    resize: (size) => ipcRenderer.invoke('window:resize', size)
  },
  capture: {
    screen: () => ipcRenderer.invoke('capture:screen')
  },
  ai: {
    call: (payload) => ipcRenderer.invoke('ai:call', payload)
  },
  translate: {
    transcribe: (payload) => ipcRenderer.invoke('whisper:transcribe', payload),
    text: (payload) => ipcRenderer.invoke('translate:text', payload)
  },
  deepgram: {
    start: (opts) => ipcRenderer.invoke('deepgram:start', opts),
    stop: () => ipcRenderer.invoke('deepgram:stop'),
    sendAudio: (int16Buffer) => ipcRenderer.send('deepgram:audio', int16Buffer)
  },
  exchange: {
    fetch: (opts) => ipcRenderer.invoke('exchange:fetch', opts)
  },
  interview: {
    answer: (payload) => ipcRenderer.invoke('interview:answer', payload),
    readFile: (path) => ipcRenderer.invoke('file:read-text', path),
    pickCV: () => ipcRenderer.invoke('file:pick-and-extract-cv')
  },
  on: (channel, fn) => {
    const allowed = [
      'shortcut:analyze', 'shortcut:answer', 'opacity:changed',
      'deepgram:interim', 'deepgram:final', 'deepgram:error'
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => fn(...args));
    }
  }
});
