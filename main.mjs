import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import os from 'os';

// --- Pfad-Fix für ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// -------------------------------

// State Management im Backend
let currentBlacklist = ['steam.exe']; // Default-Blacklist
let mainWindow = null;
let gamingActive = false; // NEU: Backend-Status der Überwachung
let isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    autoHideMenuBar: true,
    // icon: path.join(__dirname, 'icon.ico'), 
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, 
      contextIsolation: true 
    },
    backgroundColor: '#1f2937'
  });
  
  mainWindow = win; // Speichern der Referenz
  
  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

// --- BLACKLIST LOGIK: Prozessüberwachung ---
const processCheckInterval = 2000; // Alle 2 Sekunden prüfen

function checkProcesses() {
    if (os.platform() !== 'win32') {
        console.warn("Process monitoring is only supported on Windows.");
        return;
    }

    // tasklist /nh (No Header) /fo csv (CSV Format)
    exec('tasklist /nh /fo csv', (error, stdout) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return;
        }

        const runningProcesses = stdout.split('\n')
            .map(line => line.trim().match(/"([^"]*)"/)?.[1].toLowerCase())
            .filter((name) => !!name);

        let blacklistedProcessFound = false;

        for (const targetProcess of currentBlacklist) {
            if (runningProcesses.includes(targetProcess)) {
                blacklistedProcessFound = true;
                break; // Mindestens ein Prozess läuft, beende Schleife
            }
        }
        
        // --- LOGIK STARTEN ---
        if (blacklistedProcessFound) {
            if (!gamingActive) {
                // Wenn ein Prozess gefunden wird und wir NICHT aktiv sind -> Starte Gaming
                gamingActive = true;
                if (mainWindow) {
                    mainWindow.webContents.send('start-gaming-mode', runningProcesses.find(p => currentBlacklist.includes(p)) || 'Unknown Process');
                }
            }
        } 
        
        // --- LOGIK STOPPEN ---
        else if (gamingActive) {
            // Wenn KEIN Prozess gefunden wird, aber wir aktiv sind -> Stoppe Gaming
            gamingActive = false;
            if (mainWindow) {
                mainWindow.webContents.send('end-gaming-mode'); // NEUES SIGNAL!
            }
        }
    });
}

// Intervall zum regelmäßigen Prozess-Check
let intervalId; 

app.whenReady().then(() => {
  createWindow();
  
  // Intervall nur starten, wenn das Fenster bereit ist
  if (!intervalId) {
    intervalId = setInterval(checkProcesses, processCheckInterval);
  }

  // IPC-HANDLER: Vom Frontend (React) aufgerufen
  ipcMain.handle('start-steam', () => {
    // Wenn der Nutzer manuell startet, setzen wir den Backend-Status auf aktiv
    gamingActive = true; 
    shell.openExternal('steam://'); 
  });

  // IPC-HANDLER: Vom Frontend (React) aufgerufen, um alle Blacklist-Programme zu schließen
  ipcMain.handle('kill-steam', () => {
    // Wenn wir manuell killen, setzen wir den Backend-Status auf inaktiv
    gamingActive = false; 
    for (const processName of currentBlacklist) {
        // /IM: Image Name, /F: Force kill
        exec(`taskkill /IM ${processName} /F`, (error) => {
            if (error) {
                if (!error.message.includes('not found')) {
                    console.warn(`Kill Fehler bei ${processName}:`, error.message);
                }
            } else {
                console.log(`${processName} erfolgreich beendet.`);
            }
        });
    }
  });
  
  // NEU IPC-RECEIVER: React sagt uns, wenn der Modus manuell BEENDET wurde
  ipcMain.on('end-gaming-manual', () => {
      // Wenn React den Modus manuell beendet (z.B. Guthaben 0 oder Stop-Button), 
      // stellen wir sicher, dass die automatische Überwachung nicht sofort wieder startet.
      gamingActive = false; 
      console.log("Backend-Status: Manuell beendet.");
  });
  
  // IPC-RECEIVER: Empfängt die Blacklist-Einstellungen vom React-Frontend
  ipcMain.on('update-settings', (event, settings) => {
      if (settings && settings.blacklistProcesses) {
          currentBlacklist = settings.blacklistProcesses.map(p => p.toLowerCase());
          console.log("Electron Blacklist aktualisiert:", currentBlacklist);
      }
  });


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    clearInterval(intervalId); // Aufräumen des Intervalls
    app.quit();
  }
});