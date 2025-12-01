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
function logError(msg) {
    try {
        const logPath = path.join(app.getPath('desktop'), 'focus-timer-debug.txt');
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) { 
        // Ignorieren, falls wir nicht schreiben können
    }
}

// State Management
let currentBlacklist = ['steam.exe']; 
let currentStartPath = 'steam://'; 
let mainWindow = null;
let gamingActive = false;
let isDev = !app.isPackaged;

// --- PFAD-ERKENNUNG (Der robuste Fix für Production) ---
function getSystemBinaryPath(binaryName) {
    const winDir = process.env.SystemRoot || 'C:\\Windows';
    
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
      preload: path.join(__dirname, 'preload.cjs'), 
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

  // --- NEU: IPC Handlers für Autostart ---
  ipcMain.handle('toggle-autostart', (event, enable) => {
      // openAtLogin ist der Schlüssel für Windows/macOS Autostart
      app.setLoginItemSettings({
          openAtLogin: enable,
          // Auf Windows: Der Pfad zur EXE ist wichtig, wenn die App nicht im Standard-Installationspfad ist
          path: app.getPath('exe') 
      });
      logError(`Autostart auf ${enable ? 'AKTIVIERT' : 'DEAKTIVIERT'} gesetzt.`);
      return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('get-autostart-status', () => {
      return app.getLoginItemSettings().openAtLogin;
  });
  // --- ENDE Autostart Handlers ---

  // IPC-HANDLER: Manuelles Starten des konfigurierten Programms
  ipcMain.handle('start-steam', () => {
    shell.openExternal(currentStartPath)
        .then(() => logError(`Startbefehl gesendet für: ${currentStartPath}`))
        .catch(err => logError(`Fehler beim Starten von ${currentStartPath}: ${err.message}`));
    
    gamingActive = true; 
  });

  // IPC-HANDLER: Manuelles Killen (Stop & Kill Button)
  ipcMain.handle('kill-steam', () => {
    gamingActive = false; 
    logError("Manuelles Killen ausgelöst.");
    
    for (const processName of currentBlacklist) {
        execFile(TASKKILL_PATH, ['/IM', processName, '/F'], (error) => {
            if (error && !error.message.includes('not found')) {
                logError(`Kill Fehler bei ${processName}: ${error.message}`);
            } else {
                logError(`${processName} erfolgreich beendet/nicht gefunden.`);
            }
        });
    }
  });
  
  // IPC-RECEIVER: Status-Updates
  ipcMain.on('end-gaming-manual', () => { 
      gamingActive = false;
      logError("Backend-Status: Manuell beendet (vom Frontend).");
  });
  
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