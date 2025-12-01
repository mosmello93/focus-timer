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
    } catch (e) { }
}

// State Management
let currentBlacklist = ['steam.exe']; 
let mainWindow = null;
let gamingActive = false;
let isDev = !app.isPackaged;

// --- PFAD-ERKENNUNG ---
function getSystemBinaryPath(binaryName) {
    const winDir = process.env.SystemRoot || 'C:\\Windows';
    const isWow64 = process.arch === 'ia32' && process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432');
    const sysDir = isWow64 ? 'Sysnative' : 'System32';
    return path.join(winDir, sysDir, binaryName);
}

const TASKKILL_PATH = getSystemBinaryPath('taskkill.exe');
const TASKLIST_PATH = getSystemBinaryPath('tasklist.exe');

logError(`App gestartet (Fix v2). Arch=${process.arch}`);

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

// --- BLACKLIST LOGIK ---
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
        
        // --- LOGIK STARTEN ---
        if (blacklistedProcessFound) {
            // FIX: Wir senden das Signal JETZT IMMER, wenn der Prozess läuft.
            // Das Frontend ignoriert es automatisch, wenn der Timer schon läuft.
            // So stellen wir sicher, dass es auch bei App-Start erkannt wird.
            if (mainWindow) {
                mainWindow.webContents.send('start-gaming-mode', foundProcessName);
            }

            if (!gamingActive) {
                gamingActive = true;
                logError(`Prozess gefunden: ${foundProcessName}. Sende Start-Signal.`);
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

  // Handler für manuellen Start
  ipcMain.handle('start-steam', () => {
    const firstProcess = currentBlacklist[0];
    if (firstProcess === 'steam.exe') {
        gamingActive = true; 
        shell.openExternal('steam://'); 
        return true; 
    } else {
        gamingActive = true;
        return false; 
    }
  });

  // Handler für manuellen Kill
  ipcMain.handle('kill-steam', () => {
    gamingActive = false; 
    logError("Manueller Kill ausgelöst.");
    for (const processName of currentBlacklist) {
        execFile(TASKKILL_PATH, ['/IM', processName, '/F'], (error) => {});
    }
  });
  
  ipcMain.on('end-gaming-manual', () => { gamingActive = false; });
  
  ipcMain.on('update-settings', (event, settings) => {
      if (settings && settings.blacklistProcesses) {
          currentBlacklist = settings.blacklistProcesses.map(p => p.toLowerCase());
          logError(`Blacklist Update empfangen: ${currentBlacklist.join(', ')}`);
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