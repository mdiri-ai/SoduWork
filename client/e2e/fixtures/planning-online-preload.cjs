'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soduWorkAPI', {
  planningHarness: packet => ipcRenderer.invoke('planning-harness-manage', packet),
  deviceAuthBootstrap: () => ipcRenderer.invoke('qa-device-auth'),
  runnerStatus: async () => ({ connected: true, running: true }),
  firstPlanningTurn: (text, options) => ipcRenderer.invoke('qa-first-turn', text, options),
  conversationSession: {
    runtimes: () => ipcRenderer.invoke('qa-runtimes'),
    probe: id => ipcRenderer.invoke('qa-probe', id),
  },
});
