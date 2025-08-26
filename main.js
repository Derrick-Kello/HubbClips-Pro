const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");

// FFmpeg Configuration
class FFmpegConfig {
    static setPath() {
        if (process.platform === 'win32') {
            // Auto-detect or use configured paths
            ffmpeg.setFfmpegPath("ffmpeg.exe");
            ffmpeg.setFfprobePath("ffprobe.exe");
        }
    }

    static getQualityPresets() {
        return {
            'ultra': { crf: 18, preset: 'slow', bitrate: '12M' },
            'high': { crf: 20, preset: 'medium', bitrate: '8M' },
            'medium': { crf: 23, preset: 'medium', bitrate: '5M' },
            'fast': { crf: 28, preset: 'fast', bitrate: '3M' },
            'copy': { codec: 'copy' }
        };
    }
}

// Video Processing Service
class VideoProcessor {
    constructor() {
        this.tempDir = path.join(__dirname, "temp");
        this.ensureTempDir();
    }

    ensureTempDir() {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    // Enhanced trimming with smart encoding
    async trimSegment(options) {
        const { inputPath, startTime, endTime, segmentId, quality = 'high', effects = [] } = options;
        const outputPath = path.join(this.tempDir, `segment_${segmentId}.mp4`);

        return new Promise((resolve, reject) => {
            const duration = endTime - startTime;
            const qualitySettings = FFmpegConfig.getQualityPresets()[quality];

            const command = ffmpeg(inputPath)
                .seekInput(startTime)
                .duration(duration);

            // Apply video effects
            this.applyEffects(command, effects);

            // Smart encoding based on conditions
            if (startTime === 0 && effects.length === 0 && quality === 'copy') {
                // Direct copy for untouched segments
                command.videoCodec('copy').audioCodec('copy');
            } else {
                // High-quality re-encoding
                command
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .audioBitrate('192k')
                    .outputOptions([
                        `-crf ${qualitySettings.crf}`,
                        `-preset ${qualitySettings.preset}`,
                        '-movflags +faststart',
                        '-pix_fmt yuv420p' // Compatibility
                    ]);
            }

            this.executeCommand(command, outputPath, 'trim', segmentId)
                .then(() => resolve({ success: true, outputPath, segmentId }))
                .catch(reject);
        });
    }

    // Advanced video merging with transitions
    async mergeVideos(options) {
        const { segments, outputPath, settings = {}, transitions = [] } = options;

        return new Promise((resolve, reject) => {
            if (segments.length === 0) {
                return reject(new Error('No segments to merge'));
            }

            if (segments.length === 1) {
                return this.handleSingleSegment(segments[0].path, outputPath, resolve, reject);
            }

            const command = ffmpeg();
            segments.forEach(segment => command.input(segment.path));

            // Build complex filter for merging
            const filterComplex = this.buildMergeFilter(segments, transitions);
            const outputSettings = this.getOutputSettings(settings);

            command
                .complexFilter(filterComplex)
                .outputOptions([
                    '-map', '[outv]',
                    '-map', '[outa]',
                    ...outputSettings
                ])
                .output(outputPath);

            this.executeCommand(command, outputPath, 'merge')
                .then(() => {
                    this.cleanupSegments(segments);
                    resolve({ success: true, outputPath });
                })
                .catch(reject);
        });
    }

    // Apply visual effects to command
    applyEffects(command, effects) {
        if (!effects || effects.length === 0) return;

        const filters = [];
        effects.forEach(effect => {
            switch (effect.type) {
                case 'brightness':
                    filters.push(`eq=brightness=${effect.parameters.value / 100}`);
                    break;
                case 'contrast':
                    filters.push(`eq=contrast=${effect.parameters.value / 100}`);
                    break;
                case 'blur':
                    filters.push(`boxblur=${effect.parameters.radius}:${effect.parameters.radius}`);
                    break;
                case 'fade-in':
                    filters.push(`fade=in:0:${effect.parameters.duration * 30}`);
                    break;
                case 'fade-out':
                    filters.push(`fade=out:${(effect.startTime || 0) * 30}:${effect.parameters.duration * 30}`);
                    break;
            }
        });

        if (filters.length > 0) {
            command.videoFilters(filters);
        }
    }

    // Build filter for merging with transitions
    buildMergeFilter(segments, transitions) {
        if (transitions.length === 0) {
            return segments.map((_, index) => `[${index}:v][${index}:a]`).join('') +
                `concat=n=${segments.length}:v=1:a=1[outv][outa]`;
        }

        // Complex filter with crossfade transitions
        let videoFilter = '';
        let audioFilter = '';

        for (let i = 0; i < segments.length - 1; i++) {
            const duration = transitions[i]?.duration || 1;
            const offset = segments[i].duration - duration;

            if (i === 0) {
                videoFilter += `[0:v][1:v]xfade=transition=fade:duration=${duration}:offset=${offset}[v${i}];`;
                audioFilter += `[0:a][1:a]acrossfade=d=${duration}[a${i}];`;
            } else {
                videoFilter += `[v${i-1}][${i+1}:v]xfade=transition=fade:duration=${duration}:offset=${offset}[v${i}];`;
                audioFilter += `[a${i-1}][${i+1}:a]acrossfade=d=${duration}[a${i}];`;
            }
        }

        const lastIndex = segments.length - 2;
        return videoFilter + audioFilter + `[v${lastIndex}][a${lastIndex}]`;
    }

    // Get output settings based on quality requirements
    getOutputSettings(settings) {
        const quality = settings.quality || 'high';
        const resolution = settings.resolution || '1080p';
        const bitrate = settings.bitrate || 8;

        const resolutionMap = {
            '4K': '3840x2160',
            '1080p': '1920x1080',
            '720p': '1280x720',
            '480p': '854x480'
        };

        const qualitySettings = FFmpegConfig.getQualityPresets()[quality];

        const options = [
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-preset', qualitySettings.preset,
            '-crf', qualitySettings.crf.toString(),
            '-movflags', '+faststart',
            '-pix_fmt', 'yuv420p'
        ];

        if (resolutionMap[resolution]) {
            options.push('-s', resolutionMap[resolution]);
        }

        // Variable bitrate for better quality
        options.push('-maxrate', `${bitrate * 1.5}M`);
        options.push('-bufsize', `${bitrate * 2}M`);

        return options;
    }

    // Execute FFmpeg command with progress tracking
    executeCommand(command, outputPath, operation, segmentId = null) {
        return new Promise((resolve, reject) => {
            command
                .on('start', (cmdline) => {
                    console.log(`${operation} started:`, cmdline);
                    this.sendProgress(operation, 'started', { segmentId });
                })
                .on('progress', (progress) => {
                    const percent = Math.max(0, Math.min(100, progress.percent || 0));
                    this.sendProgress(operation, 'processing', {
                        segmentId,
                        percent,
                        fps: progress.currentFps,
                        speed: progress.speed
                    });
                })
                .on('end', () => {
                    this.sendProgress(operation, 'completed', { segmentId });
                    resolve();
                })
                .on('error', (err) => {
                    console.error(`${operation} error:`, err);
                    this.sendProgress(operation, 'error', {
                        segmentId,
                        error: err.message
                    });
                    reject(err);
                })
                .run();
        });
    }

    // Handle single segment copy
    handleSingleSegment(inputPath, outputPath, resolve, reject) {
        try {
            fs.copyFileSync(inputPath, outputPath);
            fs.unlinkSync(inputPath);
            resolve({ success: true, outputPath });
        } catch (err) {
            reject(err);
        }
    }

    // Clean up temporary segment files
    cleanupSegments(segments) {
        segments.forEach(segment => {
            try {
                if (fs.existsSync(segment.path)) {
                    fs.unlinkSync(segment.path);
                }
            } catch (err) {
                console.error('Error cleaning up segment:', err);
            }
        });
    }

    // Send progress updates to renderer
    sendProgress(operation, stage, data = {}) {
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('operation-progress', {
                operation,
                stage,
                timestamp: Date.now(),
                ...data
            });
        }
    }

    // Cleanup temp directory
    cleanup() {
        try {
            if (fs.existsSync(this.tempDir)) {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            }
        } catch (err) {
            console.error("Error cleaning temp directory:", err);
        }
    }
}

// Audio Processing Service
class AudioProcessor {
    constructor(videoProcessor) {
        this.videoProcessor = videoProcessor;
    }

    async extractAudio(options) {
        const { inputPath, outputPath, format = 'mp3', quality = 'high' } = options;

        return new Promise((resolve, reject) => {
            const command = ffmpeg(inputPath).noVideo();

            // Audio quality settings
            const audioSettings = {
                'high': { bitrate: '320k', sampleRate: '48000' },
                'medium': { bitrate: '192k', sampleRate: '44100' },
                'low': { bitrate: '128k', sampleRate: '44100' }
            };

            const settings = audioSettings[quality] || audioSettings.medium;

            if (format === 'wav') {
                command.audioCodec('pcm_s16le');
            } else {
                command
                    .audioCodec(format === 'aac' ? 'aac' : 'mp3')
                    .audioBitrate(settings.bitrate)
                    .audioFrequency(settings.sampleRate);
            }

            this.videoProcessor.executeCommand(command, outputPath, 'extract-audio')
                .then(() => resolve({ success: true, outputPath }))
                .catch(reject);
        });
    }

    async replaceAudio(options) {
        const { videoPath, audioPath, outputPath, mode = 'replace' } = options;

        return new Promise((resolve, reject) => {
            const command = ffmpeg()
                .input(videoPath)
                .input(audioPath);

            if (mode === 'replace') {
                command.outputOptions([
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-map', '0:v:0',
                    '-map', '1:a:0',
                    '-shortest'
                ]);
            } else if (mode === 'mix') {
                command
                    .complexFilter('[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=3[aout]')
                    .outputOptions([
                        '-c:v', 'copy',
                        '-map', '0:v:0',
                        '-map', '[aout]'
                    ]);
            }

            this.videoProcessor.executeCommand(command, outputPath, 'replace-audio')
                .then(() => resolve({ success: true, outputPath }))
                .catch(reject);
        });
    }
}

// Media Information Service
class MediaInfoService {
    static async getMediaInfo(filePath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) return reject(err);

                const videoStream = metadata.streams.find(s => s.codec_type === "video");
                const audioStream = metadata.streams.find(s => s.codec_type === "audio");

                let fps = 30;
                if (videoStream?.r_frame_rate) {
                    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
                    fps = num / den;
                }

                resolve({
                    id: uuidv4(),
                    filePath,
                    fileName: path.basename(filePath),
                    fileSize: metadata.format.size || 0,
                    duration: parseFloat(metadata.format.duration) || 0,
                    bitrate: parseInt(metadata.format.bit_rate) || 0,
                    hasVideo: !!videoStream,
                    hasAudio: !!audioStream,
                    video: videoStream ? {
                        width: videoStream.width,
                        height: videoStream.height,
                        fps: Math.round(fps),
                        codec: videoStream.codec_name,
                        bitrate: parseInt(videoStream.bit_rate) || 0,
                        pixelFormat: videoStream.pix_fmt
                    } : null,
                    audio: audioStream ? {
                        codec: audioStream.codec_name,
                        sampleRate: parseInt(audioStream.sample_rate) || 44100,
                        channels: audioStream.channels || 2,
                        bitrate: parseInt(audioStream.bit_rate) || 0
                    } : null,
                    metadata: {
                        format: metadata.format.format_name,
                        duration: metadata.format.duration,
                        tags: metadata.format.tags || {}
                    }
                });
            });
        });
    }

    static async generateThumbnail(options) {
        const { inputPath, timestamp = 1, outputPath, size = '320x240' } = options;

        return new Promise((resolve, reject) => {
            const thumbPath = outputPath || path.join(videoProcessor.tempDir, `thumb_${Date.now()}.jpg`);

            ffmpeg(inputPath)
                .seekInput(timestamp)
                .frames(1)
                .size(size)
                .outputOptions(['-q:v', '2']) // High quality JPEG
                .output(thumbPath)
                .on('end', () => resolve({ success: true, thumbnailPath: thumbPath }))
                .on('error', reject)
                .run();
        });
    }
}

// Main Application
let mainWindow;
let videoProcessor;
let audioProcessor;

FFmpegConfig.setPath();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 1200,
        minHeight: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
            webSecurity: false
        },
        show: false,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default'
    });

    // Initialize services
    videoProcessor = new VideoProcessor();
    audioProcessor = new AudioProcessor(videoProcessor);

    mainWindow.loadFile("index.html");

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        if (process.argv.includes("--dev")) {
            mainWindow.webContents.openDevTools();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// App lifecycle
app.whenReady().then(createWindow);

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", () => {
    if (videoProcessor) {
        videoProcessor.cleanup();
    }
});

// IPC Handlers - File Operations
ipcMain.handle("select-video-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile", "multiSelections"],
        filters: [
            { name: "Video Files", extensions: ["mp4", "avi", "mov", "mkv", "webm", "flv"] },
            { name: "Audio Files", extensions: ["mp3", "wav", "aac", "m4a", "flac", "ogg"] },
            { name: "All Files", extensions: ["*"] }
        ]
    });
    return !result.canceled ? result.filePaths : [];
});

// IPC Handlers - Media Processing
ipcMain.handle("get-media-info", (event, filePath) =>
    MediaInfoService.getMediaInfo(filePath));

ipcMain.handle("generate-thumbnail", (event, options) =>
    MediaInfoService.generateThumbnail(options));

ipcMain.handle('trim-video-segment', (event, options) =>
    videoProcessor.trimSegment(options));

ipcMain.handle('merge-videos', (event, options) =>
    videoProcessor.mergeVideos(options));

ipcMain.handle('extract-audio', (event, options) =>
    audioProcessor.extractAudio(options));

ipcMain.handle('replace-audio', (event, options) =>
    audioProcessor.replaceAudio(options));

// IPC Handlers - Project Management
ipcMain.handle('save-video-dialog', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
        filters: [
            { name: 'MP4 Video', extensions: ['mp4'] },
            { name: 'AVI Video', extensions: ['avi'] },
            { name: 'MOV Video', extensions: ['mov'] }
        ],
        defaultPath: 'edited_video.mp4'
    });
    return !result.canceled ? result.filePath : null;
});

ipcMain.handle('save-project-dialog', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
        filters: [{ name: 'Video Editor Project', extensions: ['vep'] }],
        defaultPath: 'project.vep'
    });
    return !result.canceled ? result.filePath : null;
});

// Error handling
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);