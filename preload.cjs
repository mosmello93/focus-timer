const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // IPC Calls (Main -> Renderer)
    onStartGaming: (callback) => ipcRenderer.on('start-gaming-mode', (event, processName) => callback(processName)),
    onEndGaming: (callback) => ipcRenderer.on('end-gaming-mode', callback),
    
    // IPC Invokes (Renderer -> Main)
    startSteam: () => ipcRenderer.invoke('start-steam'),
    killSteam: () => ipcRenderer.invoke('kill-steam'),
    
    // Settings & State Sync
    endGamingManual: () => ipcRenderer.send('end-gaming-manual'),
    sendSettings: (settings) => ipcRenderer.send('update-settings', settings),
    
    // --- NEU: Autostart Funktionen ---
    toggleAutostart: (enable) => ipcRenderer.invoke('toggle-autostart', enable),
    getAutostartStatus: () => ipcRenderer.invoke('get-autostart-status'),
    // --- ENDE Autostart Funktionen ---
});