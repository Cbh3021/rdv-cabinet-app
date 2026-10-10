const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Une seule instance de l'application
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win;

function indexPath() {
  // Version empaquetée : desktop/www ; en dev : ../www
  const packed = path.join(__dirname, 'www', 'index.html');
  if (fs.existsSync(packed)) return packed;
  return path.join(__dirname, '..', 'www', 'index.html');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 420,
    minHeight: 600,
    autoHideMenuBar: true,
    title: 'RDV CBH',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(indexPath());

  // Les liens externes (tel:, https://...) s'ouvrent hors de l'application
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
