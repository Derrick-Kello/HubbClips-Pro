const { contextBridge, ipcRenderer } = require("electron");

// File Management API
const fileAPI = {
    // File selection dialogs
    selectVideoFiles: () => ipcRenderer.invoke("select-video-files"),
    selectAudioFile: () => ipcRenderer.invoke("select-audio-file"),

    // Save dialogs
    saveVideoDialog: () => ipcRenderer.invoke("save-video-dialog"),
    saveAudioDialog: () => ipcRenderer.invoke("save-audio-dialog"),
    saveProjectDialog: () => ipcRenderer.invoke("save-project-dialog"),
    openProjectDialog: () => ipcRenderer.invoke("open-project-dialog"),

    // File operations
    saveProject: (filePath, projectData) => ipcRenderer.invoke("save-project", filePath, projectData),
    loadProject: (filePath) => ipcRenderer.invoke("load-project", filePath),

    // File path utilities
    getVideoUrl: (filePath) => {
        if (process.platform === 'win32') {
            return `file:///${filePath.replace(/\\/g, '/')}`;
        }
        return `file://${filePath}`;
    }
};

// Media Processing API
const mediaAPI = {
    // Media information
    getMediaInfo: (filePath) => ipcRenderer.invoke("get-media-info", filePath),
    generateThumbnail: (options) => ipcRenderer.invoke("generate-thumbnail", options),

    // Video operations
    trimVideoSegment: (options) => {
        // Validate options
        const required = ['inputPath', 'startTime', 'endTime', 'segmentId'];
        const missing = required.filter(key => !(key in options));
        if (missing.length > 0) {
            return Promise.reject(new Error(`Missing required parameters: ${missing.join(', ')}`));
        }

        return ipcRenderer.invoke("trim-video-segment", {
            quality: 'high', // Default to high quality
            effects: [],
            ...options
        });
    },

    mergeVideos: (options) => {
        if (!options.segments || options.segments.length === 0) {
            return Promise.reject(new Error('No segments provided for merging'));
        }

        return ipcRenderer.invoke("merge-videos", {
            settings: {
                quality: 'high',
                resolution: '1080p',
                bitrate: 8,
                format: 'mp4'
            },
            transitions: [],
            ...options
        });
    },

    applyEffect: (options) => ipcRenderer.invoke("apply-effect", options),

    // Audio operations
    extractAudio: (options) => ipcRenderer.invoke("extract-audio", {
        format: 'mp3',
        quality: 'high',
        ...options
    }),

    replaceAudio: (options) => ipcRenderer.invoke("replace-audio", {
        mode: 'replace',
        ...options
    }),

    removeAudio: (options) => ipcRenderer.invoke("remove-audio", options),

    // Batch operations
    processBatch: async (operations) => {
        const results = [];
        for (const operation of operations) {
            try {
                let result;
                switch (operation.type) {
                    case 'trim':
                        result = await mediaAPI.trimVideoSegment(operation.options);
                        break;
                    case 'extract-audio':
                        result = await mediaAPI.extractAudio(operation.options);
                        break;
                    case 'apply-effect':
                        result = await mediaAPI.applyEffect(operation.options);
                        break;
                    default:
                        throw new Error(`Unknown operation type: ${operation.type}`);
                }
                results.push({ success: true, result, operationId: operation.id });
            } catch (error) {
                results.push({ success: false, error: error.message, operationId: operation.id });
            }
        }
        return results;
    }
};

// Progress and Event Management API
const eventAPI = {
    // Progress tracking
    onOperationProgress: (callback) => {
        const handler = (event, data) => {
            callback({
                operation: data.operation,
                stage: data.stage,
                percent: data.percent || 0,
                segmentId: data.segmentId,
                error: data.error,
                timestamp: data.timestamp || Date.now(),
                fps: data.fps,
                speed: data.speed
            });
        };

        ipcRenderer.on("operation-progress", handler);

        // Return cleanup function
        return () => ipcRenderer.removeListener("operation-progress", handler);
    },

    // Event cleanup
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    },

    // Progress aggregation for multiple operations
    createProgressTracker: () => {
        const tracker = {
            operations: new Map(),
            callbacks: new Set(),

            track: function(operationId, callback) {
                this.callbacks.add(callback);
                return this.onOperationProgress((progress) => {
                    this.operations.set(progress.operation + (progress.segmentId || ''), progress);
                    this.notifyCallbacks();
                });
            },

            notifyCallbacks: function() {
                const allOperations = Array.from(this.operations.values());
                const totalPercent = allOperations.reduce((sum, op) => sum + op.percent, 0) / allOperations.length;
                const isComplete = allOperations.every(op => op.stage === 'completed');
                const hasError = allOperations.some(op => op.stage === 'error');

                this.callbacks.forEach(callback => {
                    callback({
                        totalPercent: totalPercent || 0,
                        isComplete,
                        hasError,
                        operations: allOperations
                    });
                });
            },

            clear: function() {
                this.operations.clear();
                this.callbacks.clear();
            }
        };

        tracker.onOperationProgress = eventAPI.onOperationProgress;
        return tracker;
    }
};

// System Integration API
const systemAPI = {
    // System information
    getSystemInfo: () => ipcRenderer.invoke("get-system-info"),
    getTempDir: () => ipcRenderer.invoke("get-temp-dir"),

    // Shell integration
    showItemInFolder: (path) => {
        require('electron').shell.showItemInFolder(path);
    },

    openPath: (path) => {
        require('electron').shell.openPath(path);
    },

    // Performance utilities
    getMemoryUsage: () => process.memoryUsage(),

    // Path utilities
    path: {
        join: (...args) => require('path').join(...args),
        dirname: (path) => require('path').dirname(path),
        basename: (path, ext) => require('path').basename(path, ext),
        extname: (path) => require('path').extname(path)
    },

    // Platform detection
    platform: process.platform,
    arch: process.arch,

    // Resource monitoring
    startResourceMonitor: (callback, interval = 1000) => {
        const monitor = setInterval(() => {
            callback({
                memory: process.memoryUsage(),
                cpu: process.getCPUUsage(),
                timestamp: Date.now()
            });
        }, interval);

        return () => clearInterval(monitor);
    }
};

// Quality and Encoding Presets API
const encodingAPI = {
    // Predefined quality presets
    getQualityPresets: () => ({
        'ultra': {
            name: 'Ultra Quality',
            crf: 18,
            preset: 'slow',
            bitrate: '12M',
            description: 'Highest quality, slower encoding'
        },
        'high': {
            name: 'High Quality',
            crf: 20,
            preset: 'medium',
            bitrate: '8M',
            description: 'High quality, balanced speed'
        },
        'medium': {
            name: 'Medium Quality',
            crf: 23,
            preset: 'medium',
            bitrate: '5M',
            description: 'Good quality, faster encoding'
        },
        'fast': {
            name: 'Fast',
            crf: 28,
            preset: 'fast',
            bitrate: '3M',
            description: 'Lower quality, fastest encoding'
        }
    }),

    // Resolution presets
    getResolutionPresets: () => ({
        '4K': { width: 3840, height: 2160, name: '4K UHD' },
        '1080p': { width: 1920, height: 1080, name: 'Full HD' },
        '720p': { width: 1280, height: 720, name: 'HD' },
        '480p': { width: 854, height: 480, name: 'SD' }
    }),

    // Format information
    getFormatInfo: () => ({
        'mp4': {
            name: 'MP4',
            extension: '.mp4',
            compatibility: 'Excellent',
            quality: 'High',
            description: 'Most compatible format'
        },
        'avi': {
            name: 'AVI',
            extension: '.avi',
            compatibility: 'Good',
            quality: 'High',
            description: 'Traditional format, larger files'
        },
        'mov': {
            name: 'MOV',
            extension: '.mov',
            compatibility: 'Good',
            quality: 'High',
            description: 'QuickTime format, Mac optimized'
        },
        'webm': {
            name: 'WebM',
            extension: '.webm',
            compatibility: 'Web',
            quality: 'Good',
            description: 'Web-optimized format'
        }
    }),

    // Calculate estimated file size
    estimateFileSize: (duration, settings) => {
        const bitrate = parseInt(settings.bitrate) || 5; // Mbps
        const estimatedMB = (duration * bitrate * 60) / 8; // Convert to MB
        return {
            mb: Math.round(estimatedMB),
            gb: (estimatedMB / 1024).toFixed(2),
            formatted: estimatedMB > 1024 ?
                `${(estimatedMB / 1024).toFixed(2)} GB` :
                `${Math.round(estimatedMB)} MB`
        };
    }
};

// Error Handling and Validation API
const validationAPI = {
    // Validate file paths
    validateFilePath: (filePath) => {
        if (!filePath || typeof filePath !== 'string') {
            return { valid: false, error: 'Invalid file path' };
        }

        const validExtensions = [
            '.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv',
            '.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg',
            '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'
        ];

        const ext = systemAPI.path.extname(filePath).toLowerCase();
        if (!validExtensions.includes(ext)) {
            return { valid: false, error: `Unsupported file format: ${ext}` };
        }

        return { valid: true };
    },

    // Validate processing options
    validateProcessingOptions: (options, type) => {
        const errors = [];

        switch (type) {
            case 'trim':
                if (!options.inputPath) errors.push('Input path required');
                if (typeof options.startTime !== 'number' || options.startTime < 0) {
                    errors.push('Valid start time required');
                }
                if (typeof options.endTime !== 'number' || options.endTime <= options.startTime) {
                    errors.push('End time must be greater than start time');
                }
                break;

            case 'merge':
                if (!Array.isArray(options.segments) || options.segments.length === 0) {
                    errors.push('Segments array required');
                }
                break;

            case 'export':
                if (!options.outputPath) errors.push('Output path required');
                if (options.settings?.bitrate && (options.settings.bitrate < 1 || options.settings.bitrate > 50)) {
                    errors.push('Bitrate must be between 1-50 Mbps');
                }
                break;
        }

        return {
            valid: errors.length === 0,
            errors
        };
    },

    // Sanitize user input
    sanitizeOptions: (options) => {
        const sanitized = { ...options };

        // Remove dangerous properties
        delete sanitized.__proto__;
        delete sanitized.constructor;

        // Sanitize numeric values
        if (typeof sanitized.startTime === 'string') {
            sanitized.startTime = parseFloat(sanitized.startTime) || 0;
        }
        if (typeof sanitized.endTime === 'string') {
            sanitized.endTime = parseFloat(sanitized.endTime) || 0;
        }
        if (typeof sanitized.bitrate === 'string') {
            sanitized.bitrate = parseInt(sanitized.bitrate) || 5;
        }

        return sanitized;
    }
};

// Cache Management API
const cacheAPI = {
    // Thumbnail cache
    thumbnailCache: new Map(),

    // Cache thumbnail
    cacheThumbnail: (filePath, thumbnailPath) => {
        cacheAPI.thumbnailCache.set(filePath, {
            path: thumbnailPath,
            timestamp: Date.now()
        });
    },

    // Get cached thumbnail
    getCachedThumbnail: (filePath) => {
        const cached = cacheAPI.thumbnailCache.get(filePath);
        if (cached && (Date.now() - cached.timestamp) < 3600000) { // 1 hour cache
            return cached.path;
        }
        return null;
    },

    // Clear expired cache
    clearExpiredCache: () => {
        const now = Date.now();
        const expired = [];

        for (const [key, value] of cacheAPI.thumbnailCache.entries()) {
            if (now - value.timestamp > 3600000) {
                expired.push(key);
            }
        }

        expired.forEach(key => cacheAPI.thumbnailCache.delete(key));
    }
};

// Main API object exposed to renderer
contextBridge.exposeInMainWorld("electronAPI", {
    // Core APIs
    ...fileAPI,
    ...mediaAPI,
    ...eventAPI,
    ...systemAPI,
    ...encodingAPI,
    ...validationAPI,

    // Cache management
    cache: cacheAPI,

    // Enhanced media operations with validation
    processMedia: {
        // Safe trimming with validation
        trim: async (options) => {
            const sanitized = validationAPI.sanitizeOptions(options);
            const validation = validationAPI.validateProcessingOptions(sanitized, 'trim');

            if (!validation.valid) {
                throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
            }

            const pathValidation = validationAPI.validateFilePath(sanitized.inputPath);
            if (!pathValidation.valid) {
                throw new Error(pathValidation.error);
            }

            return mediaAPI.trimVideoSegment(sanitized);
        },

        // Safe merging with validation
        merge: async (options) => {
            const sanitized = validationAPI.sanitizeOptions(options);
            const validation = validationAPI.validateProcessingOptions(sanitized, 'merge');

            if (!validation.valid) {
                throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
            }

            return mediaAPI.mergeVideos(sanitized);
        },

        // Safe export with validation
        export: async (options) => {
            const sanitized = validationAPI.sanitizeOptions(options);
            const validation = validationAPI.validateProcessingOptions(sanitized, 'export');

            if (!validation.valid) {
                throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
            }

            return mediaAPI.mergeVideos(sanitized);
        }
    },

    // Utility functions
    utils: {
        // Format time for display
        formatTime: (seconds) => {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);

            if (hours > 0) {
                return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            }
            return `${minutes}:${secs.toString().padStart(2, '0')}`;
        },

        // Format file size
        formatFileSize: (bytes) => {
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            if (bytes === 0) return '0 B';

            const i = Math.floor(Math.log(bytes) / Math.log(1024));
            return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
        },

        // Generate unique ID
        generateId: () => {
            return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        },

        // Debounce function
        debounce: (func, wait) => {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        },

        // Deep clone object
        deepClone: (obj) => {
            return JSON.parse(JSON.stringify(obj));
        }
    },

    // Constants
    constants: {
        SUPPORTED_VIDEO_FORMATS: ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv'],
        SUPPORTED_AUDIO_FORMATS: ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg'],
        SUPPORTED_IMAGE_FORMATS: ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'],

        MAX_BITRATE: 50,
        MIN_BITRATE: 1,
        DEFAULT_BITRATE: 8,

        QUALITY_PRESETS: ['ultra', 'high', 'medium', 'fast'],
        RESOLUTION_PRESETS: ['4K', '1080p', '720p', '480p'],

        CACHE_DURATION: 3600000 // 1 hour in milliseconds
    },

    // Version and build info
    version: {
        app: process.env.npm_package_version || '1.0.0',
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch
    }
});