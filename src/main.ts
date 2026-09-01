import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface Recurrence {
  daysOfWeek: number[];
  startDate: string;
  endDate: string | null;
}

interface AppEvent {
  id: string;
  bundleId: string | null;
  title: string | null;
  description: string | null;
  color?: string;
  kind: 'punctual' | 'recurring';
  date: string | null;
  recurrence: Recurrence | null;
  startTime: string;
  endTime: string;
  notifyMinutesBefore?: number;
  active?: boolean;
}

interface AppBundle {
  id: string;
  title: string;
  description: string;
  color: string;
  hourOffset?: number;
}

interface AppSettings {
  timeFormat: '24h' | '12h';
  dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY/MM/DD';
  startWithWindows: boolean;
}

interface AppData {
  version: number;
  events: AppEvent[];
  bundles: AppBundle[];
  settings?: AppSettings;
}

const DEFAULT_SETTINGS: AppSettings = {
  timeFormat: '24h',
  dateFormat: 'MM/DD/YYYY',
  startWithWindows: true,
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let latestData: AppData = { version: 1, events: [], bundles: [], settings: DEFAULT_SETTINGS };

// Set via the login-item's launch args (see reconcileLoginItem) so a
// startup-triggered launch opens tray-only instead of showing the window.
const startHidden = process.argv.includes('--hidden');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.raidtimeapp.app');
}

// Electron/Chromium has a known Windows bug where app.getPath('userData')
// can mangle non-ASCII characters in the account name (confirmed here: it
// was resolving to a mojibake'd folder distinct from the real profile
// path, so the app was silently reading/writing an empty data.json in the
// wrong place). Node's own os.homedir() doesn't share this bug, so pin
// userData explicitly instead of trusting Electron's default resolution.
const realUserDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'raidtimeapp');
fs.mkdirSync(realUserDataPath, { recursive: true });
app.setPath('userData', realUserDataPath);

// Without this, every launch (a manual `electron .`, a duplicate double-
// click, or the Windows startup entry firing while the app is already
// open) spawns a separate process against the same data.json — two
// instances then race to read/write it, and whichever saves last silently
// clobbers the other's in-memory state. A losing instance here quits
// immediately instead of ever touching the filesystem or creating a window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// In an unpackaged dev run (`electron .`), process.execPath points at the
// bare electron.exe binary, which needs this app's path as its first
// argument to know what to launch — a packaged build's exe already knows,
// so this is skipped there. Login-item args must be identical between
// setLoginItemSettings and getLoginItemSettings, or Windows' registry-value
// comparison reports openAtLogin: false even after a successful set.
function loginItemArgs(): string[] {
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}

function reconcileLoginItem(settings: AppSettings): void {
  if (process.platform !== 'win32') return;
  const openAtLogin = settings.startWithWindows;
  app.setLoginItemSettings({
    openAtLogin,
    path: process.execPath,
    args: openAtLogin ? loginItemArgs() : [],
  });
}

function createWindow(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 860,
    minHeight: 600,
    show: !startHidden,
    icon: nativeImage.createFromPath(iconPath),
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Minimizing sends the app to the tray instead of the taskbar.
  mainWindow.on('minimize', () => {
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // If an update finished downloading while the window was hidden to tray,
  // this is what actually surfaces the toast once the user opens it back up.
  mainWindow.on('show', notifyUpdateReadyIfVisible);
}

function createTray(): void {
  const trayIconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  tray = new Tray(nativeImage.createFromPath(trayIconPath));
  updateTrayTooltip();

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open RaidTimeApp',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function dataFilePath(): string {
  return path.join(app.getPath('userData'), 'data.json');
}

ipcMain.handle('data:load', () => {
  try {
    const raw = fs.readFileSync(dataFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as AppData;
    latestData = parsed;
    return parsed;
  } catch {
    return null;
  }
});

ipcMain.handle('data:save', (_event, data: AppData) => {
  fs.writeFileSync(dataFilePath(), JSON.stringify(data, null, 2), 'utf-8');
  latestData = data;
  reconcileLoginItem(data.settings || DEFAULT_SETTINGS);
  updateTrayTooltip();
  return true;
});

ipcMain.handle('settings:getLoginItemStatus', () => {
  if (process.platform !== 'win32') return null;
  return app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs() }).openAtLogin;
});

// ---------- notifications ----------

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

function todayKey(date: Date): string {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

// Shifts a "HH:MM" time of day by a whole-hour offset, wrapping within the
// same calendar day. Mirrors the renderer's applyHourOffset for the
// bundle-level DST/timezone correction.
function applyHourOffset(timeStr: string, offsetHours: number): string {
  if (!offsetHours) return timeStr;
  const [h, m] = timeStr.split(':').map(Number);
  const total = (((h * 60 + m + offsetHours * 60) % 1440) + 1440) % 1440;
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
}

function resolveBundleOffset(ev: AppEvent): number {
  const bundle = latestData.bundles.find((b) => b.id === ev.bundleId);
  return bundle ? bundle.hourOffset || 0 : 0;
}

// Mirrors the renderer's formatTimeDisplay — notification bodies are
// user-facing text, so they respect the same time-format setting.
function formatTimeForDisplay(timeStr: string): string {
  const settings = latestData.settings || DEFAULT_SETTINGS;
  if (settings.timeFormat !== '12h') return timeStr;
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ':' + pad2(m) + ' ' + period;
}

function resolveEventTitle(ev: AppEvent): string {
  if (ev.title != null) return ev.title;
  const bundle = latestData.bundles.find((b) => b.id === ev.bundleId);
  return bundle ? bundle.title : 'Event';
}

// ---------- tray tooltip ----------
// checkNotifications() below only asks "does this occur today" — enough
// for firing today's reminders, not enough to find "the next occurrence,
// however many days out." This duplicates a little occurrence-matching
// logic that also exists in the renderer's getEventsForDate — main.ts and
// renderer.js are separate, unbundled script contexts with no shared
// module today, so a small third copy here is the pragmatic option. See
// .specs/features/dynamic-tray-tooltip/design.md.

const TRAY_LOOKAHEAD_DAYS = 30;

interface Occurrence {
  event: AppEvent;
  start: Date;
  end: Date;
}

function eventOccursOnDate(ev: AppEvent, date: Date): boolean {
  const dayKey = todayKey(date);
  const dow = date.getDay();
  if (ev.kind === 'punctual') return ev.date === dayKey;
  if (ev.kind === 'recurring' && ev.recurrence) {
    return (
      ev.recurrence.daysOfWeek.includes(dow) &&
      dayKey >= ev.recurrence.startDate &&
      (!ev.recurrence.endDate || dayKey <= ev.recurrence.endDate)
    );
  }
  return false;
}

// Effective (hourOffset-applied) start/end as real Date objects on the
// given calendar date, spilling into the next day if the event crosses
// midnight — mirrors the overnight convention used throughout the app
// (end <= start means it wraps).
function occurrenceDateTimes(ev: AppEvent, date: Date): { start: Date; end: Date } {
  const offset = resolveBundleOffset(ev);
  const effStart = applyHourOffset(ev.startTime, offset);
  const effEnd = applyHourOffset(ev.endTime, offset);
  const [sh, sm] = effStart.split(':').map(Number);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), sh, sm, 0, 0);
  const [eh, em] = effEnd.split(':').map(Number);
  let end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), eh, em, 0, 0);
  if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function findRelevantOccurrence(now: Date): Occurrence | null {
  // In-progress can only be true for something that started today or
  // yesterday (an overnight event) — check just those two days first.
  for (let dOff = -1; dOff <= 0; dOff++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dOff);
    for (const ev of latestData.events) {
      if (ev.active === false) continue;
      if (!eventOccursOnDate(ev, date)) continue;
      const { start, end } = occurrenceDateTimes(ev, date);
      if (now >= start && now < end) return { event: ev, start, end };
    }
  }

  // Otherwise scan forward day by day. Because days are scanned in order
  // and every event is checked before moving to the next day, the first
  // day that yields any future-starting candidate necessarily contains
  // the overall-earliest one — safe to stop there.
  for (let dayOffset = 0; dayOffset <= TRAY_LOOKAHEAD_DAYS; dayOffset++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    let best: Occurrence | null = null;
    for (const ev of latestData.events) {
      if (ev.active === false) continue;
      if (!eventOccursOnDate(ev, date)) continue;
      const { start, end } = occurrenceDateTimes(ev, date);
      if (start > now && (!best || start < best.start)) best = { event: ev, start, end };
    }
    if (best) return best;
  }
  return null;
}

const NO_UPCOMING_TOOLTIP = 'RaidTimeApp — no raids on the horizon';

function hhmmOf(d: Date): string {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function truncateTitle(title: string, maxLen: number): string {
  return title.length > maxLen ? title.slice(0, maxLen - 1) + '…' : title;
}

function formatTrayTooltip(now: Date): string {
  const occ = findRelevantOccurrence(now);
  if (!occ) return NO_UPCOMING_TOOLTIP;

  const title = truncateTitle(resolveEventTitle(occ.event), 40);

  if (now >= occ.start && now < occ.end) {
    return '🔴 ' + title + ' — ends ' + formatTimeForDisplay(hhmmOf(occ.end));
  }

  const diffMin = Math.round((occ.start.getTime() - now.getTime()) / 60000);
  if (diffMin < 1) return '🔥 ' + title + ' is starting now';
  if (diffMin < 60) return '⚔️ ' + title + ' in ' + diffMin + 'm';
  if (diffMin < 24 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return '⚔️ ' + title + ' in ' + h + 'h' + (m ? ' ' + m + 'm' : '');
  }
  if (diffMin < 48 * 60) {
    return '⚔️ ' + title + ' tomorrow at ' + formatTimeForDisplay(hhmmOf(occ.start));
  }
  return '⚔️ ' + title + ' in ' + Math.ceil(diffMin / (24 * 60)) + ' days';
}

function updateTrayTooltip(): void {
  tray?.setToolTip(formatTrayTooltip(new Date()));
}

function fireEventNotification(ev: AppEvent, body: string): void {
  if (!Notification.isSupported()) return;
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const title = resolveEventTitle(ev);

  const notification = new Notification({
    title,
    body,
    icon: nativeImage.createFromPath(iconPath),
  });
  notification.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  notification.show();
}

// How long after the scheduled start we still allow the "starting now"
// notification to fire, in case a tick was missed (sleep, app just launched).
const START_NOTIFY_GRACE_MS = 5 * 60 * 1000;

let notifiedDayKey = '';
let notifiedEventKeys = new Set<string>();

function checkNotifications(): void {
  const now = new Date();
  const dayKey = todayKey(now);
  if (dayKey !== notifiedDayKey) {
    notifiedDayKey = dayKey;
    notifiedEventKeys = new Set();
  }
  const dow = now.getDay();

  for (const ev of latestData.events) {
    if (ev.active === false) continue;
    const minutesBefore = ev.notifyMinutesBefore || 0;
    if (!minutesBefore) continue;

    let occursToday = false;
    if (ev.kind === 'punctual') {
      occursToday = ev.date === dayKey;
    } else if (ev.kind === 'recurring' && ev.recurrence) {
      occursToday =
        ev.recurrence.daysOfWeek.includes(dow) &&
        dayKey >= ev.recurrence.startDate &&
        (!ev.recurrence.endDate || dayKey <= ev.recurrence.endDate);
    }
    if (!occursToday) continue;

    const offset = resolveBundleOffset(ev);
    const effStartTime = applyHourOffset(ev.startTime, offset);
    const effEndTime = applyHourOffset(ev.endTime, offset);

    const [hours, minutes] = effStartTime.split(':').map(Number);
    const startDateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
    const reminderTime = new Date(startDateTime.getTime() - minutesBefore * 60000);
    // Keyed on the effective scheduled time so editing an event's schedule
    // (or its lead time, or the bundle's offset) always produces a fresh,
    // un-fired occurrence.
    const occurrenceTag = effStartTime + '|' + minutesBefore;

    const displayStartTime = formatTimeForDisplay(effStartTime);
    const displayEndTime = formatTimeForDisplay(effEndTime);

    const reminderKey = ev.id + '|' + dayKey + '|' + occurrenceTag + '|reminder';
    if (!notifiedEventKeys.has(reminderKey) && now >= reminderTime && now < startDateTime) {
      fireEventNotification(ev, `Starts in ${minutesBefore} min · ${displayStartTime}–${displayEndTime}`);
      notifiedEventKeys.add(reminderKey);
    }

    const startKey = ev.id + '|' + dayKey + '|' + occurrenceTag + '|start';
    const startGraceEnd = new Date(startDateTime.getTime() + START_NOTIFY_GRACE_MS);
    if (!notifiedEventKeys.has(startKey) && now >= startDateTime && now < startGraceEnd) {
      fireEventNotification(ev, `Starting now · ${displayStartTime}–${displayEndTime}`);
      notifiedEventKeys.add(startKey);
    }
  }
}

// ---------- auto-update ----------
// Checks GitHub Releases (see build.publish in package.json) for a newer
// version, downloads it silently in the background, and only bothers the
// user with a toast if the window is actually open when it's ready - never
// while just minimized to tray. If the toast is dismissed or never seen,
// autoInstallOnAppQuit still applies the update the next time the app is
// fully quit (the X button), so nothing is lost by staying quiet.

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updateReady = false;
let updateAlreadyNotified = false;

autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('error', (err) => {
  console.error('[auto-update]', err);
});
autoUpdater.on('update-downloaded', () => {
  updateReady = true;
  notifyUpdateReadyIfVisible();
});

function notifyUpdateReadyIfVisible(): void {
  if (!updateReady || updateAlreadyNotified) return;
  if (!mainWindow || !mainWindow.isVisible()) return;
  updateAlreadyNotified = true;
  mainWindow.webContents.send('update:ready');
}

ipcMain.handle('update:restart', () => {
  autoUpdater.quitAndInstall();
});

if (gotSingleInstanceLock) {
  // A second launch attempt while we're already running — surface the
  // existing window instead of letting a competing instance start up.
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
    checkNotifications();
    setInterval(() => {
      checkNotifications();
      updateTrayTooltip();
    }, 20000);

    // Update checks only make sense against a packaged, installed build -
    // an unpackaged `electron .` dev run has no installer version to
    // compare against and no local dev-app-update.yml is set up for it.
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch((err) => console.error('[auto-update]', err));
      setInterval(() => {
        autoUpdater.checkForUpdates().catch((err) => console.error('[auto-update]', err));
      }, UPDATE_CHECK_INTERVAL_MS);
    }
  });

  // Closing the window (the X button) fully quits the app, unlike minimize.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
