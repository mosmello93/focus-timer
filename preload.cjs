const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    startSteam: () => ipcRenderer.invoke('start-steam'),
    killSteam: () => ipcRenderer.invoke('kill-steam'),
    
    // NEU: Signal, wenn der Timer manuell beendet wird, um die Backend-Überwachung zu stoppen
    endGamingManual: () => ipcRenderer.send('end-gaming-manual'),
    
    // Signal vom Backend, um Gaming zu starten
    onStartGaming: (callback) => {
        ipcRenderer.removeAllListeners('start-gaming-mode');
        ipcRenderer.on('start-gaming-mode', (event, processName) => callback(processName));
    },
    
    // NEU: Signal vom Backend, um Gaming automatisch zu beenden (wenn Prozess geschlossen)
    onEndGaming: (callback) => {
        ipcRenderer.removeAllListeners('end-gaming-mode');
        ipcRenderer.on('end-gaming-mode', (event) => callback());
    },
    
    // Funktion, um die Blacklist-Einstellungen vom Frontend an das Backend zu senden
    sendSettings: (settings) => ipcRenderer.send('update-settings', settings),
});