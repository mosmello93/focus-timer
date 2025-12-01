import { useState, useEffect, useMemo, useRef } from 'react'; 
import { 
  Clock, Gamepad2, AlertCircle, Settings, 
  Plus, Trash2, Lock, Briefcase, BarChart3, Moon, Sun, Volume2, VolumeX, FolderOpen, RotateCcw, Zap
} from 'lucide-react';

// --- TYPEDEFS ---
declare global {
  interface Window {
    electron?: {
      startSteam: () => void;
      killSteam: () => void;
      
      onStartGaming: (callback: (processName: string) => void) => void; 
      onEndGaming: (callback: () => void) => void; 
      endGamingManual: () => void; 
      sendSettings: (settings: AppSettings) => void;
      
      // NEU: Autostart Funktionen
      toggleAutostart: (enable: boolean) => Promise<boolean>;
      getAutostartStatus: () => Promise<boolean>;
    };
  }
}

type Mode = 'idle' | 'working' | 'gaming';
type ThemeMode = 'dark' | 'light';

interface Session {
  id: number;
  type: 'work' | 'game';
  category?: string;
  duration: number;
  timestamp: string;
  earned?: number;
}

interface AppSettings {
  ratio: number;
  dailyAllowance: number;
  processName: string;
  categories: string[];
  password?: string;
  themeMode: ThemeMode;
  blacklistProcesses: string[];
  soundEnabled: boolean; 
  startPath: string; 
}

const Themes = {
    dark: {
        baseBg: 'bg-gray-900', 
        headerBg: 'bg-gray-800', 
        cardBg: 'bg-gray-700', 
        cardBorder: 'border-gray-600',
        textPrimary: 'text-white',
        textSecondary: 'text-gray-400',
        workAccent: 'bg-emerald-700 hover:bg-emerald-600', 
        gamingAccent: 'bg-red-600 hover:bg-red-500', 
        primaryColor: 'text-blue-400', 
        gamingWarning: 'text-red-500', 
        workLabel: 'bg-emerald-950/30 text-emerald-400 border-emerald-500/30',
        gamingLabel: 'bg-red-950/30 text-red-400 border-red-500/30',
    },
    light: {
        baseBg: 'bg-white', 
        headerBg: 'bg-gray-100', 
        cardBg: 'bg-white', 
        cardBorder: 'border-gray-200',
        textPrimary: 'text-gray-900',
        textSecondary: 'text-gray-600',
        workAccent: 'bg-lime-500 hover:bg-lime-400', 
        gamingAccent: 'bg-rose-500 hover:bg-rose-400', 
        primaryColor: 'text-blue-600', 
        gamingWarning: 'text-red-700', 
        workLabel: 'bg-lime-100 text-lime-600 border-lime-300',
        gamingLabel: 'bg-rose-100 text-rose-600 border-rose-300',
    }
};

const DEFAULT_CATEGORIES = ['Projekt UDE', 'Schulung', 'Haushalt', 'Sonstiges'];
const DEFAULT_SETTINGS: AppSettings = {
  ratio: 0.5,
  dailyAllowance: 30,
  processName: 'steam.exe', 
  categories: DEFAULT_CATEGORIES,
  themeMode: 'dark', 
  blacklistProcesses: ['steam.exe'], 
  soundEnabled: true, 
  startPath: 'steam://',
};

// --- AUDIO ENGINE (Synthesizer) ---
const playSound = (type: 'warning' | 'critical' | 'start' | 'end') => {
    if (typeof window === 'undefined' || !window.AudioContext) return;

    const ctx = new window.AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;

    if (type === 'warning') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.1);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        osc.start(now);
        osc.stop(now + 0.5);
    } else if (type === 'critical') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(800, now);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.setValueAtTime(0, now + 0.1);
        gain.gain.setValueAtTime(0.1, now + 0.2);
        gain.gain.setValueAtTime(0, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.4);
    } else if (type === 'start') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.linearRampToValueAtTime(440, now + 0.2);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
    } else if (type === 'end') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.linearRampToValueAtTime(110, now + 0.3);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.4);
    }
};

const App = () => {
  // --- STATE ---
  const [balance, setBalance] = useState<number>(0); 
  const [mode, setMode] = useState<Mode>('idle');
  const [sessionTime, setSessionTime] = useState<number>(0);
  const [selectedCategory, setSelectedCategory] = useState<string>(DEFAULT_CATEGORIES[0]);
  const [history, setHistory] = useState<Session[]>([]);
  const [view, setView] = useState<'timer' | 'stats' | 'settings'>('timer');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  
  const [newCategory, setNewCategory] = useState('');
  const [newBlacklistProcess, setNewBlacklistProcess] = useState(''); 
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [processAlert, setProcessAlert] = useState<string | null>(null); 
  const [isElectronConnected, setIsElectronConnected] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false); // NEU: Autostart Status

  const loaded = useRef(false);
  const isGameOver = balance <= 0 && mode === 'gaming';
  const theme = Themes[settings.themeMode];

  // --- PERSISTENZ & INITIALISIERUNG ---
  useEffect(() => {
    if (window.electron) setIsElectronConnected(true);

    // Lade Autostart Status
    if (window.electron?.getAutostartStatus) {
        window.electron.getAutostartStatus().then(status => setAutostartEnabled(status));
    }

    const savedBalance = localStorage.getItem('st_balance');
    const savedHistory = localStorage.getItem('st_history');
    const savedSettings = localStorage.getItem('st_settings');
    const lastLogin = localStorage.getItem('st_last_login');

    if (savedBalance) setBalance(parseFloat(savedBalance));
    if (savedHistory) setHistory(JSON.parse(savedHistory));
    
    let currentSettings: AppSettings = DEFAULT_SETTINGS;
    if (savedSettings) {
      currentSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) };
      currentSettings.themeMode = currentSettings.themeMode || 'dark'; 
      if (!currentSettings.blacklistProcesses || currentSettings.blacklistProcesses.length === 0) {
        currentSettings.blacklistProcesses = [currentSettings.processName || 'steam.exe'];
      }
      if (currentSettings.soundEnabled === undefined) currentSettings.soundEnabled = true;
      if (!currentSettings.startPath) currentSettings.startPath = 'steam://';

      setSettings(currentSettings);
      if (currentSettings.categories.length > 0) setSelectedCategory(currentSettings.categories[0]);
    }

    const today = new Date().toDateString();
    if (lastLogin !== today) {
      const bonusSeconds = currentSettings.dailyAllowance * 60;
      setBalance(prev => prev + bonusSeconds);
      localStorage.setItem('st_last_login', today);
    }

    loaded.current = true;
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    localStorage.setItem('st_balance', balance.toString());
    localStorage.setItem('st_history', JSON.stringify(history));
    localStorage.setItem('st_settings', JSON.stringify(settings)); 
  }, [balance, history, settings]);
  
  // Senden der Settings an Electron
  useEffect(() => {
      if (window.electron?.sendSettings) window.electron.sendSettings(settings);
  }, [settings]);

  // Handler für Autostart Toggle
  const toggleAutostart = async () => {
    if (window.electron?.toggleAutostart) {
        const newStatus = !autostartEnabled;
        const finalStatus = await window.electron.toggleAutostart(newStatus);
        setAutostartEnabled(finalStatus);
        setProcessAlert(`Autostart ${finalStatus ? 'aktiviert' : 'deaktiviert'}.`);
        setTimeout(() => setProcessAlert(null), 3000);
    }
  };

  useEffect(() => {
    if (window.electron?.onStartGaming) {
        window.electron.onStartGaming((processName) => {
            if (mode === 'idle' || mode === 'working') {
                if (settings.soundEnabled) playSound('start');
                setMode('gaming');
                setProcessAlert(`Automatischer Spielstart: ${processName} erkannt.`);
                setTimeout(() => setProcessAlert(null), 3000);
            }
        });
    }
  }, [mode, settings.soundEnabled]); 

  useEffect(() => {
    if (window.electron?.onEndGaming) {
        window.electron.onEndGaming(() => {
            if (mode === 'gaming') {
                if (settings.soundEnabled) playSound('end');
                stopSession(false); 
                setProcessAlert(`Prozess geschlossen. Spielmodus beendet.`);
                setTimeout(() => setProcessAlert(null), 3000);
            }
        });
    }
  }, [mode, settings.soundEnabled]);

  const triggerSteamStart = () => window.electron?.startSteam() || console.log(">> Start App");
  const triggerSteamKill = () => window.electron?.killSteam() || console.log(">> Kill App");

  const resetBalanceToDailyAllowance = () => {
    const dailyAllowanceSeconds = settings.dailyAllowance * 60;
    setBalance(dailyAllowanceSeconds);
    setProcessAlert(`Guthaben auf ${formatTime(dailyAllowanceSeconds)} (Tageslimit) zurückgesetzt.`);
    setTimeout(() => setProcessAlert(null), 3000);
  };
  
  useEffect(() => {
    let interval: any = null;

    if (mode === 'working') {
      interval = setInterval(() => {
        setSessionTime(prev => prev + 1);
        setBalance(prev => prev + settings.ratio); 
      }, 1000);
    } else if (mode === 'gaming') {
      interval = setInterval(() => {
        setSessionTime(prev => prev + 1);
        setBalance(prev => {
          if (settings.soundEnabled) {
              if (prev === 300) playSound('warning');
              if (prev === 60) playSound('critical');
          }

          if (prev <= 1) {
            triggerSteamKill();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => clearInterval(interval);
  }, [mode, settings.ratio, settings.soundEnabled]); 

  const stopSession = (killProcesses: boolean = true) => {
    if (mode === 'gaming' && window.electron?.endGamingManual) {
        window.electron.endGamingManual();
    }
    if (mode === 'gaming' && killProcesses) triggerSteamKill();

    if (sessionTime > 0) {
      const newSession: Session = {
        id: Date.now(),
        type: mode === 'working' ? 'work' : 'game',
        duration: sessionTime,
        timestamp: new Date().toISOString(),
        category: mode === 'working' ? selectedCategory : undefined,
        earned: mode === 'working' ? sessionTime * settings.ratio : undefined
      };
      setHistory(prev => [newSession, ...prev]);
    }
    setMode('idle');
    setSessionTime(0);
  };

  const handleAddCategory = () => {
    if (newCategory && !settings.categories.includes(newCategory)) {
      setSettings(prev => ({ ...prev, categories: [...prev.categories, newCategory] }));
      setNewCategory('');
    }
  };

  const handleDeleteCategory = (cat: string) => {
    setSettings(prev => ({ ...prev, categories: prev.categories.filter(c => c !== cat) }));
    if (selectedCategory === cat) setSelectedCategory(settings.categories[0] || '');
  };

  const enterSettings = () => {
    if (settings.password && !settingsUnlocked) {
      setShowPasswordPrompt(true);
    } else {
      setView('settings');
    }
  };

  const unlockSettings = () => {
    if (passwordInput === settings.password) {
      setSettingsUnlocked(true);
      setShowPasswordPrompt(false);
      setPasswordInput('');
      setView('settings');
    } else {
      alert("Falsches Passwort!");
    }
  };
  
  const handleAddBlacklistProcess = () => {
    const proc = newBlacklistProcess.trim().toLowerCase();
    if (proc && !settings.blacklistProcesses.includes(proc)) {
        setSettings(prev => ({ ...prev, blacklistProcesses: [...prev.blacklistProcesses, proc] }));
        setNewBlacklistProcess('');
    }
  };
  
  const handleDeleteBlacklistProcess = (proc: string) => {
    setSettings(prev => ({ ...prev, blacklistProcesses: prev.blacklistProcesses.filter((p: string) => p !== proc) }));
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const stats = useMemo(() => {
    const totalWork = history.filter(s => s.type === 'work').reduce((acc, curr) => acc + curr.duration, 0);
    const totalGame = history.filter(s => s.type === 'game').reduce((acc, curr) => acc + curr.duration, 0);
    return { totalWork, totalGame };
  }, [history]);

  if (isGameOver) {
    return (
      <div className={`fixed inset-0 bg-red-900/95 z-50 flex flex-col items-center justify-center ${theme.textPrimary} animate-pulse drag-region`}>
        <AlertCircle size={80} className="mb-6" />
        <h1 className="text-6xl font-black mb-4 tracking-tighter uppercase">Time's Up</h1>
        <p className="text-xl opacity-80 mb-8">Der Prozess wurde beendet. Zeit, wieder produktiv zu sein.</p>
        <button 
          onClick={() => stopSession(false)} 
          className="bg-white text-red-900 px-8 py-3 rounded-md font-bold hover:bg-gray-200 transition no-drag"
        >
          Reset (Verstanden)
        </button>
      </div>
    );
  }

  if (showPasswordPrompt) {
    return (
       <div className="fixed inset-0 bg-black/80 z-40 flex items-center justify-center p-4">
         <div className={`bg-gray-800 p-8 rounded-xl border border-gray-700 w-full max-w-md text-center ${theme.textPrimary}`}>
            <Lock size={48} className={`mx-auto ${theme.primaryColor} mb-4`} />
            <h2 className="text-xl font-bold mb-4">Einstellungen geschützt</h2>
            <input 
              type="password" 
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Passwort eingeben..."
              className={`w-full bg-gray-900 ${theme.textPrimary} p-3 rounded border border-gray-700 mb-4 outline-none focus:border-blue-400`}
            />
            <div className="flex gap-2">
              <button onClick={() => setShowPasswordPrompt(false)} className={`${theme.textSecondary} flex-1 py-2 hover:${theme.textPrimary}`}>Abbrechen</button>
              <button onClick={unlockSettings} className={`flex-1 py-2 bg-blue-500 text-white font-bold rounded hover:bg-blue-600`}>Entsperren</button>
            </div>
         </div>
       </div>
    );
  }

  return (
    <div className={`min-h-screen ${theme.baseBg} ${theme.textPrimary} font-sans flex flex-col`}>
      <header className={`${theme.headerBg} border-b ${theme.cardBorder} p-4 flex justify-between items-center shadow-xl sticky top-0 z-10 drag-region`}>
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 ${theme.cardBg} rounded-full flex items-center justify-center border border-gray-600`}>
            <Clock size={20} className={`${theme.primaryColor}`} />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-wide">FOCUS TIMER</h1>
            <span className={`text-xs ${theme.primaryColor} uppercase tracking-wider font-semibold`}>Produktivitäts-Controller</span>
          </div>
        </div>
        
        <div className={`flex ${theme.cardBg} rounded-lg p-1 no-drag border ${theme.cardBorder}`}>
          <button onClick={() => setView('timer')} className={`p-2 rounded-md transition-all ${view === 'timer' ? `bg-gray-700 ${theme.primaryColor}` : `${theme.textSecondary} hover:${theme.textPrimary}`}`} title="Timer"><Clock size={18} /></button>
          <button onClick={() => setView('stats')} className={`p-2 rounded-md transition-all ${view === 'stats' ? `bg-gray-700 ${theme.primaryColor}` : `${theme.textSecondary} hover:${theme.textPrimary}`}`} title="Statistik"><BarChart3 size={18} /></button>
          <button onClick={enterSettings} className={`p-2 rounded-md transition-all ${view === 'settings' ? `bg-gray-700 ${theme.primaryColor}` : `${theme.textSecondary} hover:${theme.textPrimary}`}`} title="Einstellungen"><Settings size={18} /></button>
        </div>
      </header>
      
      {processAlert && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded-lg shadow-lg z-30 animate-in fade-in slide-in-from-top-4 duration-300">
              {processAlert}
          </div>
      )}

      <main className="flex-1 p-6 flex flex-col items-center justify-center w-full max-w-4xl mx-auto overflow-y-auto">
        
        {view === 'timer' && (
          <div className="w-full max-w-2xl flex flex-col gap-6 animate-in fade-in zoom-in duration-300">
            <div className={`relative overflow-hidden rounded-2xl border-2 transition-colors duration-500 shadow-2xl p-10 text-center ${theme.cardBg} ${theme.cardBorder}`}>
              
              <div className="mb-4">
                  {mode === 'working' && <span className={`uppercase tracking-widest text-xs font-bold border px-3 py-1 rounded-full ${theme.workLabel}`}>Arbeitsmodus</span>}
                  {mode === 'gaming' && <span className={`uppercase tracking-widest text-xs font-bold border px-3 py-1 rounded-full ${theme.gamingLabel}`}>Freizeit aktiv</span>}
                  {mode === 'idle' && <span className="text-gray-500 uppercase tracking-widest text-xs font-bold">Bereit</span>}
              </div>

              <div className={`font-mono text-7xl md:text-8xl font-black mb-2 tracking-tighter ${mode === 'working' ? theme.textPrimary : mode === 'gaming' && balance < 60 ? theme.gamingWarning + ' animate-pulse' : theme.primaryColor}`}>
                {mode === 'working' ? formatTime(sessionTime) : formatTime(balance)}
              </div>
              <div className={`text-sm ${theme.textSecondary} font-medium uppercase tracking-wide mb-6`}>{mode === 'working' ? 'Session Dauer' : 'Verfügbares Guthaben'}</div>

              <div className={`flex justify-between text-xs ${theme.textSecondary} border-t ${theme.cardBorder} pt-4`}>
                 <span>Ratio: {settings.ratio < 1 ? `1h Arbeit = ${Math.round(settings.ratio * 60)}min Spiel` : '1:1 oder besser'}</span>
                 <span>{mode === 'working' ? `Verdienst: +${formatTime(sessionTime * settings.ratio)}` : 'Viel Spaß!'}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className={`p-5 rounded-xl border transition-all flex flex-col gap-4 ${theme.cardBg} ${theme.cardBorder}`}>
                <div className="flex items-center gap-2 font-bold"><Briefcase size={18} className="text-emerald-500"/> Arbeit</div>
                <select 
                  disabled={mode !== 'idle'} value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)}
                  className={`bg-gray-700 ${theme.textPrimary} text-sm p-2 rounded border ${theme.cardBorder} outline-none`}
                >
                  {settings.categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                {mode === 'working' ? (
                  <button onClick={() => stopSession(true)} className="w-full py-3 bg-red-600 text-white rounded-lg font-bold border border-red-800 hover:bg-red-500 no-drag">Beenden</button>
                ) : (
                  <button onClick={() => setMode('working')} disabled={mode !== 'idle'} className={`w-full py-3 ${theme.workAccent} text-white rounded-lg font-bold disabled:opacity-50 transition no-drag`}>Starten</button>
                )}
              </div>

              <div className={`p-5 rounded-xl border transition-all flex flex-col gap-4 justify-between ${theme.cardBg} ${theme.cardBorder}`}>
                <div className="flex items-center gap-2 font-bold"><Gamepad2 size={18} className="text-red-500"/> Freizeit / Gaming</div>
                <div className={`text-xs ${theme.textSecondary} h-full flex items-center`}>
                    {settings.startPath.includes('://') ? (
                        `Start-Link: ${settings.startPath}`
                    ) : (
                        `Start-App: ${settings.startPath.split('\\').pop() || 'Nicht konfiguriert'}`
                    )}
                </div>
                {mode === 'gaming' ? (
                  <button onClick={() => stopSession(true)} className="w-full py-3 bg-red-600 text-white rounded-lg font-bold border border-red-800 hover:bg-red-500 no-drag">Stop & Kill</button>
                ) : (
                  <button onClick={() => { 
                      if (settings.soundEnabled) playSound('start');
                      triggerSteamStart(); 
                      setMode('gaming'); 
                  }} disabled={mode !== 'idle' || balance <= 0} className={`w-full py-3 ${theme.gamingAccent} text-white rounded-lg font-bold disabled:opacity-50 transition no-drag`}>Spiel Starten</button>
                )}
              </div>
            </div>
          </div>
        )}

        {view === 'stats' && (
          <div className="w-full max-w-3xl space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
             <div className="grid grid-cols-2 gap-4 mb-4">
                <div className={`p-4 rounded-xl border ${theme.cardBorder} ${theme.cardBg} text-center`}>
                  <div className={`text-xs uppercase mb-1 ${theme.textSecondary}`}>Total Arbeit</div>
                  <div className={`text-2xl font-mono text-emerald-500`}>{formatTime(stats.totalWork)}</div>
                </div>
                <div className={`p-4 rounded-xl border ${theme.cardBorder} ${theme.cardBg} text-center`}>
                  <div className={`text-xs uppercase mb-1 ${theme.textSecondary}`}>Total Spiel</div>
                  <div className={`text-2xl font-mono text-red-500`}>{formatTime(stats.totalGame)}</div>
                </div>
             </div>
             <div className={`rounded-xl border ${theme.cardBorder} ${theme.cardBg} overflow-hidden`}>
                <table className="w-full text-sm text-left">
                  <thead className={`bg-gray-700/50 text-xs ${theme.textSecondary} uppercase`}>
                    <tr><th className="px-4 py-3">Typ</th><th className="px-4 py-3">Kat</th><th className="px-4 py-3">Dauer</th><th className="px-4 py-3 text-right">Datum</th></tr>
                  </thead>
                  <tbody className={`divide-y ${theme.cardBorder}`}>
                    {history.map((s) => (
                      <tr key={s.id} className={`hover:bg-white/5`}>
                        <td className="px-4 py-2"><span className={`text-xs px-2 py-0.5 rounded ${s.type==='work'?'bg-emerald-900/50 text-emerald-400':'bg-red-900/50 text-red-400'}`}>{s.type === 'work' ? 'Arbeit' : 'Spiel'}</span></td>
                        <td className="px-4 py-2 text-gray-300">{s.category || '-'}</td>
                        <td className="px-4 py-2 font-mono">{formatTime(s.duration)}</td>
                        <td className="px-4 py-2 text-right ${theme.textSecondary} text-xs">{new Date(s.timestamp).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
             </div>
          </div>
        )}

        {view === 'settings' && (
          <div className={`w-full max-w-2xl ${theme.cardBg} rounded-xl border ${theme.cardBorder} p-6 animate-in fade-in zoom-in duration-300`}>
            <h2 className={`text-xl font-bold mb-6 flex items-center gap-2 ${theme.textPrimary}`}><Settings className={`${theme.primaryColor}`}/> Einstellungen</h2>
            
            <div className="space-y-6">
              
               {/* NEU: Autostart Toggle */}
              <div className={`p-4 rounded-lg border ${theme.cardBorder} ${theme.cardBg} flex justify-between items-center`}>
                <div>
                    <label className={`block text-sm font-bold ${theme.textPrimary} mb-1 flex items-center gap-2`}><Zap size={16}/> System-Autostart</label>
                    <p className={`text-xs ${theme.textSecondary}`}>Startet die Anwendung automatisch beim Hochfahren des Systems.</p>
                </div>
                <button 
                    onClick={toggleAutostart} 
                    className={`px-3 py-1 rounded-full font-bold transition no-drag text-sm ${autostartEnabled ? 'bg-emerald-600 text-white' : 'bg-gray-600 text-gray-300'} border border-gray-500`}
                >
                    {autostartEnabled ? 'Aktiviert' : 'Deaktiviert'}
                </button>
              </div>

               {/* Startpfad Konfiguration */}
              <div className={`p-4 rounded-lg border ${theme.cardBorder} ${theme.cardBg}`}>
                <label className={`block text-sm font-bold mb-2 ${theme.textPrimary}`}>Applikation beim Start öffnen</label>
                <div className="flex gap-2 items-center">
                   <FolderOpen size={16} className={`${theme.textSecondary}`}/>
                   <input 
                    type="text" 
                    value={settings.startPath || ''}
                    onChange={(e) => setSettings({...settings, startPath: e.target.value})}
                    placeholder="Steam:// oder C:\Pfad\zur\App.exe"
                    className={`flex-1 bg-transparent border-none ${theme.textPrimary} focus:ring-0 placeholder-gray-500`}
                  />
                </div>
                <p className={`text-xs mt-1 ${theme.textSecondary}`}>Geben Sie entweder einen Protokoll-Link (z.B. <code>steam://</code>) oder den <strong>vollständigen Pfad zur .exe-Datei</strong> ein. Dies wird beim Drücken von "Spiel Starten" ausgeführt.</p>
              </div>
              
               {/* Theme Toggle */}
              <div className={`p-4 rounded-lg border ${theme.cardBorder} ${theme.cardBg}`}>
                <label className={`block text-sm font-bold mb-2 ${theme.textPrimary}`}>Design-Modus</label>
                <div className="flex gap-4 items-center">
                    <button 
                        onClick={() => setSettings({...settings, themeMode: settings.themeMode === 'dark' ? 'light' : 'dark'})}
                        className={`px-4 py-2 rounded-lg font-bold transition flex items-center gap-2 ${theme.primaryColor} border border-gray-500 hover:border-blue-400 no-drag`}
                    >
                        {settings.themeMode === 'dark' ? <><Sun size={18}/> Light Mode aktivieren</> : <><Moon size={18}/> Dark Mode aktivieren</>}
                    </button>
                </div>
              </div>

               {/* Sound Toggle */}
              <div className={`p-4 rounded-lg border ${theme.cardBorder} ${theme.cardBg}`}>
                <label className={`block text-sm font-bold mb-2 ${theme.textPrimary}`}>Soundeffekte</label>
                <div className="flex gap-4 items-center">
                    <button 
                        onClick={() => {
                            const newState = !settings.soundEnabled;
                            setSettings({...settings, soundEnabled: newState});
                            if(newState) playSound('start');
                        }}
                        className={`px-4 py-2 rounded-lg font-bold transition flex items-center gap-2 ${settings.soundEnabled ? 'bg-emerald-600 text-white' : 'bg-gray-600 text-gray-300'} border border-gray-500 no-drag`}
                    >
                        {settings.soundEnabled ? <><Volume2 size={18}/> Sound aktiviert</> : <><VolumeX size={18}/> Sound stummgeschaltet</>}
                    </button>
                </div>
                <p className={`text-xs mt-2 ${theme.textSecondary}`}>Spielt Warntöne bei 5 Minuten und 1 Minute Restzeit.</p>
              </div>

              {/* Ratio Control */}
              <div className={`p-4 rounded-lg border ${theme.cardBorder} ${theme.cardBg}`}>
                <label className={`block text-sm font-bold mb-2 ${theme.textPrimary}`}>Umrechnungskurs (Ratio)</label>
                <div className="flex gap-4 items-center">
                  <input 
                    type="range" min="0.1" max="2.0" step="0.1" 
                    value={settings.ratio}
                    onChange={(e) => setSettings({...settings, ratio: parseFloat(e.target.value)})}
                    className={`flex-1 h-2 ${theme.cardBorder} rounded-lg appearance-none cursor-pointer accent-blue-500 no-drag`}
                  />
                  <span className={`font-mono ${theme.primaryColor} w-12 text-right`}>{settings.ratio}x</span>
                </div>
                <p className={`text-xs mt-2 ${theme.textSecondary}`}>1 Stunde Arbeit = {Math.round(settings.ratio * 60)} Minuten Spielzeit</p>
              </div>

              {/* Daily Allowance */}
              <div className={`p-4 rounded-lg border ${theme.cardBorder} ${theme.cardBg}`}>
                <label className={`block text-sm font-bold mb-2 ${theme.textPrimary}`}>Tägliches Grundguthaben (Minuten)</label>
                <div className='flex gap-2'>
                  <input 
                    type="number" 
                    value={settings.dailyAllowance}
                    onChange={(e) => setSettings({...settings, dailyAllowance: parseInt(e.target.value) || 0})}
                    className={`bg-gray-700 border ${theme.cardBorder} rounded p-2 ${theme.textPrimary} w-full focus:border-emerald-500 outline-none`}
                  />
                  <button 
                      onClick={resetBalanceToDailyAllowance} 
                      title="Guthaben jetzt zurücksetzen"
                      className='bg-blue-500 hover:bg-blue-600 text-white p-2 rounded no-drag flex items-center justify-center transition-colors'
                  >
                      <RotateCcw size={20} />
                  </button>
                </div>
              </div>
              
              {/* Target Blacklist Processes */}
              <div className={`p-4 rounded-lg border ${theme.cardBorder} ${theme.cardBg}`}>
                <label className={`block text-sm font-bold mb-4 ${theme.textPrimary}`}>Zu überwachende Prozesse (Blacklist)</label>
                <div className="flex gap-2 mb-4">
                  <input 
                    type="text" 
                    value={newBlacklistProcess} onChange={(e) => setNewBlacklistProcess(e.target.value)}
                    placeholder="discord.exe, epicgameslauncher.exe..."
                    className={`flex-1 bg-gray-700 border ${theme.cardBorder} rounded p-2 ${theme.textPrimary} focus:border-red-500 outline-none`}
                  />
                  <button onClick={handleAddBlacklistProcess} className="bg-red-700 hover:bg-red-600 text-white p-2 rounded no-drag"><Plus size={20}/></button>
                </div>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {settings.blacklistProcesses.map((proc: string) => (
                    <div key={proc} className={`flex justify-between items-center bg-gray-700/50 p-2 rounded border ${theme.cardBorder}`}>
                      <span className="text-sm">{proc}</span>
                      <button onClick={() => handleDeleteBlacklistProcess(proc)} className="text-red-400 hover:text-red-300 no-drag"><Trash2 size={16}/></button>
                    </div>
                  ))}
                </div>
              </div>
              
              {/* Categories */}
              <div className={`p-4 rounded-lg border ${theme.cardBorder} ${theme.cardBg}`}>
                <label className={`block text-sm font-bold mb-4 ${theme.textPrimary}`}>Arbeits-Kategorien</label>
                <div className="flex gap-2 mb-4">
                  <input 
                    type="text" 
                    value={newCategory} onChange={(e) => setNewCategory(e.target.value)}
                    placeholder="Neue Kategorie..."
                    className={`flex-1 bg-gray-700 border ${theme.cardBorder} rounded p-2 ${theme.textPrimary} focus:border-emerald-500 outline-none`}
                  />
                  <button onClick={handleAddCategory} className="bg-emerald-700 hover:bg-emerald-600 text-white p-2 rounded no-drag"><Plus size={20}/></button>
                </div>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {settings.categories.map(cat => (
                    <div key={cat} className={`flex justify-between items-center bg-gray-700/50 p-2 rounded border ${theme.cardBorder}`}>
                      <span className="text-sm">{cat}</span>
                      <button onClick={() => handleDeleteCategory(cat)} className="text-red-400 hover:text-red-300 no-drag"><Trash2 size={16}/></button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Password */}
              <div className={`p-4 rounded-lg border ${theme.cardBorder} ${theme.cardBg}`}>
                <label className={`block text-sm font-bold mb-2 ${theme.textPrimary}`}>Passwortschutz (Eltern)</label>
                <div className="flex gap-2 items-center">
                   <Lock size={16} className={`${theme.textSecondary}`}/>
                   <input 
                    type="password" 
                    value={settings.password || ''}
                    onChange={(e) => setSettings({...settings, password: e.target.value})}
                    placeholder="Kein Passwort gesetzt"
                    className={`flex-1 bg-transparent border-none ${theme.textPrimary} focus:ring-0 placeholder-gray-500`}
                  />
                </div>
              </div>

            </div>
          </div>
        )}

      </main>

      <footer className={`p-3 text-center text-[10px] ${theme.textSecondary} border-t ${theme.cardBorder} ${theme.headerBg} no-drag flex justify-between px-6`}>
        <span>Focus Timer v2.3 (Autostart)</span>
        <span className={isElectronConnected ? 'text-emerald-500' : 'text-red-500 font-bold'}>
             System: {isElectronConnected ? 'Verbunden' : 'FEHLER'}
        </span>
      </footer>
    </div>
  );
};

export default App;