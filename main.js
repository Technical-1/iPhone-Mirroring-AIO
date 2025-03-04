const { app, BrowserWindow, ipcMain } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

let mainWindow;

// Folder for normal "Take Screenshot" images
const screenshotFolder = path.join(__dirname, "apppages");
if (!fs.existsSync(screenshotFolder)) {
  fs.mkdirSync(screenshotFolder, { recursive: true });
}

const calibrationFolder = path.join(__dirname, "calibration");
if (!fs.existsSync(calibrationFolder)) {
  fs.mkdirSync(calibrationFolder, { recursive: true });
  console.log("Created calibration folder:", calibrationFolder);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --------------------------------------------------------------------
// TAKE SCREENSHOT (AppleScript) - writes to screenshotFolder
// --------------------------------------------------------------------
// main.js
ipcMain.on('take-screenshot', (event) => {
  const scriptLines = [
    'tell application "System Events"',
    '    tell process "iPhone Mirroring"',
    '        set frontmost to true',
    '        set theWindow to UI element 1',
    '        set {winX, winY} to position of theWindow',
    '        set {winW, winH} to size of theWindow',
    '    end tell',
    'end tell',
    'set timestamp to do shell script "date +%Y%m%d_%H%M%S"',
    `set folderPath to POSIX path of "${screenshotFolder}"`,
    'set screenshotPath to folderPath & "/screenshot_" & timestamp & ".png"',
    'set captureCmd to "screencapture -R" & winX & "," & winY & "," & winW & "," & winH & " " & quoted form of screenshotPath',
    'do shell script captureCmd',
    'return screenshotPath'
  ];

  const scriptArgs = scriptLines
    .map(l => `-e "${l.replace(/"/g, '\\"')}"`)
    .join(" ");

  exec(`osascript ${scriptArgs}`, (error, stdout) => {
    if (error) {
      // Send error to renderer
      event.reply('take-screenshot-result', { success: false, message: error.message });
    } else {
      // Send success + path to renderer
      event.reply('take-screenshot-result', {
        success: true,
        screenshotPath: stdout.trim()
      });
    }
  });
});


// --------------------------------------------------------------------
// GET SCREENSHOTS for the sidebar
// --------------------------------------------------------------------
ipcMain.handle('get-screenshots', async () => {
  try {
    const files = fs.readdirSync(screenshotFolder)
      .filter(f => f.toLowerCase().endsWith('.png'))
      .map(f => path.join(screenshotFolder, f))
      .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files;
  } catch (err) {
    console.error("Error reading screenshotFolder:", err);
    return [];
  }
});

// --------------------------------------------------------------------
// APPLESCRIPT CALIBRATE (3x3 grid) => grid_offsets.txt + grid_screenshot.png (Desktop)
// --------------------------------------------------------------------
ipcMain.on('apple-calibrate', (event) => {
  const scriptLines = [
    'set numRows to 3',
    'set numCols to 3',
    'set clickDelay to 0.3',
    'set gridStartFraction to 0.15',
    'set gridEndFraction to 0.85',
    'tell application "System Events"',
    '    tell process "iPhone Mirroring"',
    '        set frontmost to true',
    '        set theWindow to UI element 1',
    '        set {winX, winY} to position of theWindow',
    '        set {winW, winH} to size of theWindow',
    '    end tell',
    'end tell',
    'set offsetLog to "Grid Click Offsets:\\n"',
    'set offsetLog to offsetLog & "Window Position: (" & winX & ", " & winY & ")\\n"',
    'set offsetLog to offsetLog & "Window Size: (" & winW & " x " & winH & ")\\n\\n"',
    'repeat with rowIndex from 0 to (numRows - 1)',
    '    repeat with colIndex from 0 to (numCols - 1)',
    '        set relX to ((colIndex + 0.5) / numCols) * winW',
    '        set gridEffectiveHeight to winH * (gridEndFraction - gridStartFraction)',
    '        set relY to (gridStartFraction * winH) + ((rowIndex + 0.5) / numRows) * gridEffectiveHeight',
    '        set absX to winX + relX',
    '        set absY to winY + relY',
    '        repeat with i from 1 to 4',
    '            do shell script "/opt/homebrew/bin/cliclick c:" & (absX as integer) & "," & (absY as integer)',
    '        end repeat',
    '        delay clickDelay',
    '        set offsetLog to offsetLog & "Cell " & (colIndex + 1) & "," & (rowIndex + 1) & ": Relative (" & (relX as integer) & ", " & (relY as integer) & ") / Absolute (" & (absX as integer) & ", " & (absY as integer) & ")\\n"',
    '    end repeat',
    'end repeat',
    `set deskPath to POSIX path of "${calibrationFolder}"`,
    'set logFile to deskPath & "/" & "grid_offsets.txt"',
    'do shell script "cat /dev/null > " & quoted form of logFile',
    'try',
    '    set theFile to POSIX file logFile',
    '    set fileRef to open for access theFile with write permission',
    '    set eof fileRef to 0',
    '    write offsetLog to fileRef',
    '    close access fileRef',
    'on error errMsg',
    '    try',
    '        close access fileRef',
    '    end try',
    '    display dialog "Error writing log: " & errMsg',
    'end try',
    'set screenshotFile to deskPath & "/" & "grid_screenshot.png"',
    'set captureCmd to "screencapture -R" & winX & "," & winY & "," & winW & "," & winH & " " & quoted form of screenshotFile',
    'do shell script captureCmd',
    'return logFile & "||" & screenshotFile'
  ];

  const scriptArgs = scriptLines
    .map(l => `-e "${l.replace(/"/g, '\\"')}"`)
    .join(" ");

  exec(`osascript ${scriptArgs}`, (error, stdout) => {
    if (error) {
      event.reply('apple-calibrate-result', { success: false, message: error.message });
      return;
    }
    const [logFile, screenshotFile] = stdout.trim().split("||");
    event.reply('apple-calibrate-result', { success: true, logFile, screenshotFile });
  });
});

// --------------------------------------------------------------------
// SAVE NATIVE CALIBRATION => "calibrated_offsets.txt" on Desktop
// --------------------------------------------------------------------
ipcMain.handle('saveNativeCalibration', (event, final) => {
  // final: { winW, winH, data: [{col,row,x,y}, ...] }
  const lines = [`Window Size: (${final.winW} x ${final.winH})`];
  for (const c of final.data) {
    lines.push(`Cell ${c.col},${c.row}: (${c.x}, ${c.y})`);
  }
  const text = lines.join("\n") + "\n";

  const outFile = path.join(calibrationFolder, "calibrated_offsets.txt");
  fs.writeFileSync(outFile, text, 'utf8');
  return true;
});