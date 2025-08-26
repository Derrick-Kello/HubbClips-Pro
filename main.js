const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

// Optional: set ffmpeg binaries if needed
// ffmpeg.setFfmpegPath('/path/to/ffmpeg');

ffmpeg.setFfprobePath(
    "C:/Users/user/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0-essentials_build/bin/ffprobe.exe"
);



let mainWindow;
const tempDir = path.join(__dirname, "temp");

// Ensure temp directory exists
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
        },
        icon: path.join(__dirname, "assets/icon.png"),
    });

    mainWindow.loadFile("index.html");

    if (process.argv.includes("--dev")) {
        mainWindow.webContents.openDevTools();
    }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Clean temp files on exit
app.on("before-quit", () => {
    try {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    } catch (err) {
        console.error("Error cleaning temp directory:", err);
    }
});

// IPC handlers --------------------

// File selection
ipcMain.handle("select-video-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile", "multiSelections"],
        filters: [
            { name: "Video Files", extensions: ["mp4", "avi", "mov", "mkv", "webm", "flv", "m4v", "wmv"] },
        ],
    });
    return !result.canceled ? result.filePaths : [];
});

ipcMain.handle("select-audio-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile"],
        filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "aac", "m4a", "flac", "ogg"] }],
    });
    return !result.canceled ? result.filePaths[0] : null;
});

// Get media info
ipcMain.handle("get-media-info", async (event, filePath) => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);

            const videoStream = metadata.streams.find((s) => s.codec_type === "video");
            const audioStream = metadata.streams.find((s) => s.codec_type === "audio");
            resolve({
                id: uuidv4(),
                filePath,
                fileName: path.basename(filePath),
                duration: metadata.format.duration,
                hasVideo: !!videoStream,
                hasAudio: !!audioStream,
                video: videoStream
                    ? {
                        width: videoStream.width,
                        height: videoStream.height,
                        fps: eval(videoStream.r_frame_rate) || 30,
                        codec: videoStream.codec_name,
                    }
                    : null,
                audio: audioStream
                    ? {
                        codec: audioStream.codec_name,
                        sampleRate: audioStream.sample_rate,
                        channels: audioStream.channels,
                    }
                    : null,
            });
        });
    });
});

// Trim video segment
ipcMain.handle('trim-video-segment', async (event, options) => {
    const { inputPath, startTime, endTime, segmentId } = options;
    const outputPath = path.join(tempDir, `segment_${segmentId}.mp4`);

    return new Promise((resolve, reject) => {
        const duration = endTime - startTime;

        ffmpeg(inputPath)
            .seekInput(startTime)
            .duration(duration)
            .output(outputPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .on('start', () => {
                event.sender.send('operation-progress', {
                    operation: 'trim',
                    segmentId,
                    stage: 'started'
                });
            })
            .on('progress', (progress) => {
                event.sender.send('operation-progress', {
                    operation: 'trim',
                    segmentId,
                    stage: 'processing',
                    percent: progress.percent
                });
            })
            .on('end', () => {
                event.sender.send('operation-progress', {
                    operation: 'trim',
                    segmentId,
                    stage: 'completed'
                });
                resolve({ success: true, outputPath, segmentId });
            })
            .on('error', (err) => {
                event.sender.send('operation-progress', {
                    operation: 'trim',
                    segmentId,
                    stage: 'error',
                    error: err.message
                });
                reject(err);
            })
            .run();
    });
});

// Merge video segments
ipcMain.handle('merge-videos', async (event, options) => {
    const { segments, outputPath } = options;

    return new Promise((resolve, reject) => {
        const command = ffmpeg();

        // Add all input segments
        segments.forEach(segment => {
            command.input(segment.path);
        });

        // Create filter complex for concatenation
        const filterComplex = segments.map((_, index) => `[${index}:v][${index}:a]`).join('') +
            `concat=n=${segments.length}:v=1:a=1[outv][outa]`;

        command
            .complexFilter(filterComplex)
            .outputOptions(['-map', '[outv]', '-map', '[outa]'])
            .videoCodec('libx264')
            .audioCodec('aac')
            .output(outputPath)
            .on('start', () => {
                event.sender.send('operation-progress', {
                    operation: 'merge',
                    stage: 'started'
                });
            })
            .on('progress', (progress) => {
                event.sender.send('operation-progress', {
                    operation: 'merge',
                    stage: 'processing',
                    percent: progress.percent
                });
            })
            .on('end', () => {
                event.sender.send('operation-progress', {
                    operation: 'merge',
                    stage: 'completed'
                });

                // Clean up temp segment files
                segments.forEach(segment => {
                    try {
                        if (fs.existsSync(segment.path)) {
                            fs.unlinkSync(segment.path);
                        }
                    } catch (err) {
                        console.error('Error cleaning up segment:', err);
                    }
                });

                resolve({ success: true, outputPath });
            })
            .on('error', (err) => {
                event.sender.send('operation-progress', {
                    operation: 'merge',
                    stage: 'error',
                    error: err.message
                });
                reject(err);
            })
            .run();
    });
});

// Extract audio from video
ipcMain.handle('extract-audio', async (event, options) => {
    const { inputPath, outputPath } = options;

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('mp3')
            .output(outputPath)
            .on('start', () => {
                event.sender.send('operation-progress', {
                    operation: 'extract-audio',
                    stage: 'started'
                });
            })
            .on('progress', (progress) => {
                event.sender.send('operation-progress', {
                    operation: 'extract-audio',
                    stage: 'processing',
                    percent: progress.percent
                });
            })
            .on('end', () => {
                event.sender.send('operation-progress', {
                    operation: 'extract-audio',
                    stage: 'completed'
                });
                resolve({ success: true, outputPath });
            })
            .on('error', (err) => {
                event.sender.send('operation-progress', {
                    operation: 'extract-audio',
                    stage: 'error',
                    error: err.message
                });
                reject(err);
            })
            .run();
    });
});

// Replace/Add audio to video
ipcMain.handle('replace-audio', async (event, options) => {
    const { videoPath, audioPath, outputPath, mode } = options; // mode: 'replace' or 'mix'

    return new Promise((resolve, reject) => {
        const command = ffmpeg()
            .input(videoPath)
            .input(audioPath);

        if (mode === 'replace') {
            // Replace existing audio
            command
                .outputOptions(['-c:v', 'copy', '-c:a', 'aac', '-map', '0:v:0', '-map', '1:a:0'])
                .output(outputPath);
        } else {
            // Mix with existing audio
            command
                .complexFilter('[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=3[aout]')
                .outputOptions(['-c:v', 'copy', '-map', '0:v:0', '-map', '[aout]'])
                .output(outputPath);
        }

        command
            .on('start', () => {
                event.sender.send('operation-progress', {
                    operation: 'replace-audio',
                    stage: 'started'
                });
            })
            .on('progress', (progress) => {
                event.sender.send('operation-progress', {
                    operation: 'replace-audio',
                    stage: 'processing',
                    percent: progress.percent
                });
            })
            .on('end', () => {
                event.sender.send('operation-progress', {
                    operation: 'replace-audio',
                    stage: 'completed'
                });
                resolve({ success: true, outputPath });
            })
            .on('error', (err) => {
                event.sender.send('operation-progress', {
                    operation: 'replace-audio',
                    stage: 'error',
                    error: err.message
                });
                reject(err);
            })
            .run();
    });
});

// Remove audio from video
ipcMain.handle('remove-audio', async (event, options) => {
    const { inputPath, outputPath } = options;

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noAudio()
            .videoCodec('copy')
            .output(outputPath)
            .on('start', () => {
                event.sender.send('operation-progress', {
                    operation: 'remove-audio',
                    stage: 'started'
                });
            })
            .on('progress', (progress) => {
                event.sender.send('operation-progress', {
                    operation: 'remove-audio',
                    stage: 'processing',
                    percent: progress.percent
                });
            })
            .on('end', () => {
                event.sender.send('operation-progress', {
                    operation: 'remove-audio',
                    stage: 'completed'
                });
                resolve({ success: true, outputPath });
            })
            .on('error', (err) => {
                event.sender.send('operation-progress', {
                    operation: 'remove-audio',
                    stage: 'error',
                    error: err.message
                });
                reject(err);
            })
            .run();
    });
});

// Save dialogs
ipcMain.handle('save-video-dialog', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
        filters: [
            { name: 'Video Files', extensions: ['mp4'] }
        ],
        defaultPath: 'edited_video.mp4'
    });

    if (!result.canceled) {
        return result.filePath;
    }
    return null;
});

ipcMain.handle('save-audio-dialog', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
        filters: [
            { name: 'Audio Files', extensions: ['mp3'] }
        ],
        defaultPath: 'extracted_audio.mp3'
    });

    if (!result.canceled) {
        return result.filePath;
    }
    return null;
});

// Get temp directory path
ipcMain.handle('get-temp-dir', () => {
    return tempDir;
});