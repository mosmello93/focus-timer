import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process'; 
import os from 'os';
import fs from 'fs'; 

// --- Pfad-Fix für ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// -------------------------------

// --- DEBUG LOGGER (Schreibt auf den Desktop) ---
// Falls etwas schiefgeht, wird hier eine Datei erstellt.
function logError(msg) {
    try {
        // Sicherstellen, dass die App-Pfad-Funktion verfügbar ist, bevor sie verwendet wird
        const logPath = path.join(app.getPath('desktop'), 'focus-timer-debug.txt');
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) { 
        // Ignorieren, falls wir nicht schreiben können
    }
}

// State Management
let currentBlacklist = ['steam.exe']; 
let currentStartPath = 'steam://'; // NEU: Standardpfad für den manuellen Start
let mainWindow = null;
let gamingActive = false;
let isDev = !app.isPackaged;

// --- PFAD-ERKENNUNG (Der robuste Fix für Production) ---
function getSystemBinaryPath(binaryName) {
    const winDir = process.env.SystemRoot || 'C:\\Windows';
    
    // Prüfen, ob wir eine 32-Bit App auf 64-Bit Windows sind (WoW64)
    // In diesem Fall müssen wir 'Sysnative' nutzen, um auf das echte System32 zuzugreifen
    const isWow64 = process.arch === 'ia32' && process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432');
    
    const sysDir = isWow64 ? 'Sysnative' : 'System32';
    const fullPath = path.join(winDir, sysDir, binaryName);
    
    return fullPath;
}

const TASKKILL_PATH = getSystemBinaryPath('taskkill.exe');
const TASKLIST_PATH = getSystemBinaryPath('tasklist.exe');

logError(`App gestartet. Arch=${process.arch}. Kill Pfad: ${TASKKILL_PATH}`);


function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), // Sicherstellen, dass .cjs geladen wird
      nodeIntegration: false, 
      contextIsolation: true 
    },
    backgroundColor: '#1f2937'
  });
  
  mainWindow = win;
  
  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

// --- BLACKLIST LOGIK: Prozessüberwachung ---
const processCheckInterval = 2000; 

function checkProcesses() {
    if (os.platform() !== 'win32') return;

    // Verwende execFile für maximale Robustheit
    execFile(TASKLIST_PATH, ['/nh', '/fo', 'csv'], (error, stdout) => {
        if (error) {
            logError(`Tasklist Fehler: ${error.message}`);
            return;
        }

        const runningProcesses = stdout.split('\n')
            .map(line => line.trim().match(/"([^"]*)"/)?.[1].toLowerCase())
            .filter((name) => !!name);

        let blacklistedProcessFound = false;
        let foundProcessName = '';

        for (const targetProcess of currentBlacklist) {
            if (runningProcesses.includes(targetProcess)) {
                blacklistedProcessFound = true;
                foundProcessName = targetProcess;
                break; 
            }
        }
        
        // --- LOGIK STARTEN (Signal senden, solange der Prozess läuft) ---
        if (blacklistedProcessFound) {
            // Sende Signal IMMER, um Race Conditions beim App-Start zu beheben
            if (mainWindow) {
                mainWindow.webContents.send('start-gaming-mode', foundProcessName);
            }

            if (!gamingActive) {
                gamingActive = true;
                logError(`Prozess gefunden: ${foundProcessName}. Starte Überwachung.`);
            }
        } 
        
        // --- LOGIK STOPPEN ---
        else if (gamingActive) {
            gamingActive = false;
            logError("Kein Prozess mehr gefunden. Sende Stop-Signal.");
            if (mainWindow) {
                mainWindow.webContents.send('end-gaming-mode');
            }
        }
    });
}

let intervalId; 

app.whenReady().then(() => {
  createWindow();
  
  logError(`Initiale Blacklist: ${currentBlacklist.join(', ')}`);
  
  if (!intervalId) {
    intervalId = setInterval(checkProcesses, processCheckInterval);
  }

  // IPC-HANDLER: Manuelles Starten des konfigurierten Programms
  ipcMain.handle('start-steam', () => {
    // currentStartPath wird vom Frontend gesetzt (z.B. steam:// oder C:\Pfad\App.exe)
    
    // Protokoll-Links (z.B. steam://) oder Pfade zur EXE
    shell.openExternal(currentStartPath)
        .then(() => logError(`Startbefehl gesendet für: ${currentStartPath}`))
        .catch(err => logError(`Fehler beim Starten von ${currentStartPath}: ${err.message}`));
    
    // Wir setzen gamingActive immer auf true, da das Frontend den Modus gewechselt hat.
    gamingActive = true; 
  });

  // IPC-HANDLER: Manuelles Killen (Stop & Kill Button)
  ipcMain.handle('kill-steam', () => {
    gamingActive = false; 
    logError("Manuelles Killen ausgelöst.");
    
    for (const processName of currentBlacklist) {
        // Verwende den expliziten taskkill-Pfad
        execFile(TASKKILL_PATH, ['/IM', processName, '/F'], (error) => {
            if (error && !error.message.includes('not found')) {
                logError(`Kill Fehler bei ${processName}: ${error.message}`);
            } else {
                logError(`${processName} erfolgreich beendet/nicht gefunden.`);
            }
        });
    }
  });
  
  // IPC-RECEIVER: React sagt uns, wenn der Modus manuell BEENDET wurde
  ipcMain.on('end-gaming-manual', () => { 
      gamingActive = false;
      logError("Backend-Status: Manuell beendet (vom Frontend).");
  });
  
  // IPC-RECEIVER: Empfängt ALLE Einstellungen vom React-Frontend (inkl. Blacklist & Startpfad)
  ipcMain.on('update-settings', (event, settings) => {
      if (settings) {
          if (settings.blacklistProcesses) {
            currentBlacklist = settings.blacklistProcesses.map(p => p.toLowerCase());
          }
          if (settings.startPath) {
              currentStartPath = settings.startPath;
          }
          logError(`Einstellungen aktualisiert. Blacklist: ${currentBlacklist.join(', ')}, Startpfad: ${currentStartPath}`);
      }
  });


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    clearInterval(intervalId); 
    app.quit();
  }
});