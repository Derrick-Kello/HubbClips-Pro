const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    // File selection
    selectVideoFiles: () => ipcRenderer.invoke("select-video-files"),
    selectAudioFile: () => ipcRenderer.invoke("select-audio-file"),

    // Media info
    getMediaInfo: (filePath) => ipcRenderer.invoke("get-media-info", filePath),

    // Video operations
    trimVideoSegment: (options) => ipcRenderer.invoke("trim-video-segment", options),
    mergeVideos: (options) => ipcRenderer.invoke("merge-videos", options),

    // Audio operations
    extractAudio: (options) => ipcRenderer.invoke("extract-audio", options),
    replaceAudio: (options) => ipcRenderer.invoke("replace-audio", options),
    removeAudio: (options) => ipcRenderer.invoke("remove-audio", options),

    // Save dialogs
    saveVideoDialog: () => ipcRenderer.invoke("save-video-dialog"),
    saveAudioDialog: () => ipcRenderer.invoke("save-audio-dialog"),

    // Utility
    getTempDir: () => ipcRenderer.invoke("get-temp-dir"),

    // Listen for progress updates
    onOperationProgress: (callback) => {
        ipcRenderer.on("operation-progress", callback);
    },

    // Remove listeners
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    },
});
