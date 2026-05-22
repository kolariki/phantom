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
    resize: (size) => ipcRenderer.invoke('window:resize', size),
    openTrading: () => ipcRenderer.invoke('window:open-trading')
  },
  capture: {
    screen: () => ipcRenderer.invoke('capture:screen')
  },
  ai: {
    call: (payload) => ipcRenderer.invoke('ai:call', payload),
    debugPrompt: (payload) => ipcRenderer.invoke('ai:debug-prompt', payload)
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
  market: {
    publicData: (opts) => ipcRenderer.invoke('market:publicData', opts)
  },
  news: {
    fetch: (opts) => ipcRenderer.invoke('news:fetch', opts)
  },
  x: {
    checkAuth:   () => ipcRenderer.invoke('x:check-auth'),
    login:       () => ipcRenderer.invoke('x:login'),
    logout:      () => ipcRenderer.invoke('x:logout'),
    fetchTweets: (opts) => ipcRenderer.invoke('x:fetch-tweets', opts)
  },
  coinglass: {
    fetch: (opts) => ipcRenderer.invoke('coinglass:fetch', opts)
  },
  orderflow: {
    fetch: (opts) => ipcRenderer.invoke('orderflow:fetch', opts)
  },
  hyperliquid: {
    fetch: (opts) => ipcRenderer.invoke('hyperliquid:fetch', opts)
  },
  defillama: {
    fetch: () => ipcRenderer.invoke('defillama:fetch')
  },
  tradetape: {
    fetch: (opts) => ipcRenderer.invoke('tradetape:fetch', opts)
  },
  marketpulse: {
    fetch: (opts) => ipcRenderer.invoke('marketpulse:fetch', opts)
  },
  scalpradar: {
    fetch: (opts) => ipcRenderer.invoke('scalpradar:fetch', opts)
  },
  trading: {
    sendAlert: (payload) => ipcRenderer.invoke('trading:sendAlert', payload),
    captureCharts: (opts) => ipcRenderer.invoke('trading:captureCharts', opts),
    updateChartSymbol: (opts) => ipcRenderer.invoke('trading:updateChartSymbol', opts)
  },
  trades: {
    log:    (payload) => ipcRenderer.invoke('trade:log', payload),
    update: (id, patch) => ipcRenderer.invoke('trade:update', { id, patch }),
    list:   (filter) => ipcRenderer.invoke('trade:list', filter),
    get:    (id) => ipcRenderer.invoke('trade:get', id),
    recent: (opts) => ipcRenderer.invoke('trade:recent', opts),
    stats:  (filter) => ipcRenderer.invoke('trade:stats', filter)
  },
  interview: {
    answer: (payload) => ipcRenderer.invoke('interview:answer', payload),
    readFile: (path) => ipcRenderer.invoke('file:read-text', path),
    pickCV: () => ipcRenderer.invoke('file:pick-and-extract-cv')
  },
  knowledge: {
    // Picker múltiple para la base de conocimiento (PDF/DOCX/TXT/MD).
    // Devuelve { docs: [{filename,text,addedAt}], errors: [string] }
    pickDocs: () => ipcRenderer.invoke('file:pick-and-extract-docs')
  },
  on: (channel, fn) => {
    const allowed = [
      'shortcut:analyze', 'shortcut:answer', 'shortcut:multi-capture-add',
      'opacity:changed',
      'deepgram:interim', 'deepgram:final', 'deepgram:error'
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => fn(...args));
    }
  }
});
