const { ipcRenderer } = require('electron');

let topStatus, sidebarDiv, focusedImg, calibrationCanvas, calCtx;

let calibrating = false;
let offsetX=0, offsetY=0;
let scaleX=1, scaleY=1;
let winW=0, winH=0;
let cells = []; // from "grid_offsets.txt"
let imgWidth=0, imgHeight=0; // actual image dimension

window.addEventListener('DOMContentLoaded', () => {
  topStatus = document.getElementById('status');
  sidebarDiv = document.getElementById('sidebar');
  focusedImg = document.getElementById('focusedImage');
  calibrationCanvas = document.getElementById('calibrationCanvas');
  calCtx = calibrationCanvas.getContext('2d');

  document.getElementById('takeScreenshotBtn').addEventListener('click', () => {
    ipcRenderer.send('take-screenshot');
  });
  ipcRenderer.on('take-screenshot-result', (event, data) => {
    if (data.success) {
      setStatus("Screenshot saved: " + data.screenshotPath);
      loadThumbnails();
    } else {
      setStatus("Screenshot error: " + data.message);
    }
  });

  document.getElementById('appleCalibrateBtn').addEventListener('click', () => {
    ipcRenderer.send('apple-calibrate');
  });
  ipcRenderer.on('apple-calibrate-result', (event, data) => {
    if (!data.success) {
      setStatus("AppleScript calibrate error: " + data.message);
      return;
    }
    setStatus(`Apple calibrate done.\nLog=${data.logFile}\nPNG=${data.screenshotFile}`);
    loadAppleScriptResults(data.logFile, data.screenshotFile);
  });

  document.getElementById('nativeCalibrateBtn').addEventListener('click', () => {
    // If we already have loaded an offsets/log pair, just start WASD calibration.
    // Otherwise, user must run apple calibrate or load offsets.
    if (cells.length === 0 || !focusedImg.src) {
      setStatus("No offsets loaded. Please run AppleScript calibrate or load offsets.");
      return;
    }
    startNativeCalibration();
  });

  loadThumbnails();
});

function setStatus(msg) {
  topStatus.innerText = msg;
}

// --------------------------------------------------------------------
// LOAD THUMBNAILS from screenshotFolder
// --------------------------------------------------------------------
function loadThumbnails() {
  ipcRenderer.invoke('get-screenshots').then(files => {
    sidebarDiv.innerHTML = "";
    files.forEach(filePath => {
      let thumb = document.createElement('img');
      thumb.src = "file://" + filePath;
      thumb.className = "thumb";
      thumb.addEventListener('click', () => {
        // Mark selected
        document.querySelectorAll('.thumb').forEach(t => t.classList.remove('selected'));
        thumb.classList.add('selected');
        setFocusedImage(filePath);
      });
      sidebarDiv.appendChild(thumb);
    });
  });
}

function setFocusedImage(filePath) {
  focusedImg.src = `file://${filePath}`;
  focusedImg.onload = () => {
    imgWidth = focusedImg.naturalWidth;
    imgHeight = focusedImg.naturalHeight;
    setStatus(`Focused: ${filePath}, size: ${imgWidth}x${imgHeight}`);
  };
}

// --------------------------------------------------------------------
// AppleScript calibration results: read .txt, display .png
// --------------------------------------------------------------------
function loadAppleScriptResults(logFile, screenshotFile) {
  // 1) read the offsets text
  fetch(`file://${logFile}`)
    .then(res => res.text())
    .then(text => {
      parseGridOffsets(text);
      // 2) set the screenshot
      focusedImg.src = `file://${screenshotFile}`;
      focusedImg.onload = () => {
        imgWidth = focusedImg.naturalWidth;
        imgHeight = focusedImg.naturalHeight;
        // Optionally auto-start calibration
        startNativeCalibration();
      };
    })
    .catch(err => {
      setStatus("Error loading offsets: " + err);
    });
}

// parse "Window Size: (344 x 764)" + "Cell 1,1: Relative (34,76)"
function parseGridOffsets(content) {
  cells = [];
  winW=0; 
  winH=0; 
  offsetX=0; 
  offsetY=0;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    let sMatch = line.match(/Window Size:\s*\((\d+)\s*x\s*(\d+)\)/);
    if (sMatch) {
      winW = parseInt(sMatch[1]);
      winH = parseInt(sMatch[2]);
    }
    let cMatch = line.match(/Cell\s+(\d+),(\d+):.*Relative\s*\((\d+),\s*(\d+)\)/);
    if (cMatch) {
      cells.push({
        col: parseInt(cMatch[1]),
        row: parseInt(cMatch[2]),
        relX: parseInt(cMatch[3]),
        relY: parseInt(cMatch[4])
      });
    }
  }
}

// --------------------------------------------------------------------
// Native WASD Calibration
// --------------------------------------------------------------------
function startNativeCalibration() {
  calibrating = true;
  calibrationCanvas.style.display = "block";

  // 1) Measure the bounding rect of #focusedImage
  const imgRect = focusedImg.getBoundingClientRect(); // <-- UPDATED
  // 2) Measure the bounding rect of the container (mainArea)
  const mainRect = document.getElementById('mainArea').getBoundingClientRect(); // <-- UPDATED

  // 3) Position the canvas relative to #mainArea
  // so the top-left corner of the canvas lines up with the top-left of the image
  const leftOffset = imgRect.x - mainRect.x; // <-- NEW
  const topOffset  = imgRect.y - mainRect.y; // <-- NEW

  calibrationCanvas.style.left = leftOffset + "px";  // <-- NEW
  calibrationCanvas.style.top  = topOffset + "px";   // <-- NEW
  calibrationCanvas.width      = Math.round(imgRect.width);
  calibrationCanvas.height     = Math.round(imgRect.height);

  // 4) Compute scale from phone window size (winW, winH) to the displayed image size
  scaleX = calibrationCanvas.width / winW;
  scaleY = calibrationCanvas.height / winH;
  offsetX = 0;
  offsetY = 0;

  drawOverlay();
  setStatus("WASD -> move, C -> commit, Q -> cancel");
}

function drawOverlay() {
  let ctx = calCtx;
  ctx.clearRect(0, 0, calibrationCanvas.width, calibrationCanvas.height);
  
  // (Optional) If you like a translucent background:
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(0, 0, calibrationCanvas.width, calibrationCanvas.height);

  ctx.fillStyle = "lime";
  ctx.font = "16px sans-serif";
  for (const c of cells) {
    let x = (c.relX * scaleX) + offsetX;
    let y = (c.relY * scaleY) + offsetY;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, 2*Math.PI);
    ctx.fill();
    ctx.fillText(`${c.col},${c.row}`, x+10, y);
  }
}

window.addEventListener('keydown', e => {
  if (!calibrating) return;
  switch(e.key) {
    case 'w': offsetY -= 1; break;
    case 's': offsetY += 1; break;
    case 'a': offsetX -= 1; break;
    case 'd': offsetX += 1; break;
    case 'c': commitNativeCalibration(); break;
    case 'q': endNativeCalibration(); setStatus("Canceled calibration."); break;
    default: break;
  }
  drawOverlay();
});

function commitNativeCalibration() {
  // Build final offsets
  const final = { winW, winH, data: [] };
  for (const c of cells) {
    let x = Math.round(c.relX * scaleX + offsetX);
    let y = Math.round(c.relY * scaleY + offsetY);
    final.data.push({ col: c.col, row: c.row, x, y });
  }
  // Save it
  ipcRenderer.invoke('saveNativeCalibration', final)
    .then(() => {
      setStatus("Saved calibrated_offsets.txt on Desktop. Done!");
      endNativeCalibration();
    })
    .catch(err => {
      setStatus("Error saving native calibration: " + err);
    });
}

function endNativeCalibration() {
  calibrating = false;
  calibrationCanvas.style.display = "none";
}
