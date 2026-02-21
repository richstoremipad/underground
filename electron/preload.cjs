const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Account CRUD
    getAccounts: () => ipcRenderer.invoke('account:get-all'),
    deleteAccount: (accountId) => ipcRenderer.invoke('account:delete', accountId),
    importRawAccounts: (rawText) => ipcRenderer.invoke('account:import-raw', rawText),

    // Verification & Validation
    verifySelected: (ids) => ipcRenderer.invoke('account:verify-selected', ids),
    validateSelected: (ids) => ipcRenderer.invoke('account:validate-selected', ids),
    fetchProfileBulk: (ids) => ipcRenderer.invoke('account:fetch-profile-bulk', ids),
    updateProject: (ids, project) => ipcRenderer.invoke('account:update-project', ids, project),
    openCsvDialog: () => ipcRenderer.invoke('dialog:open-csv'),

    // Browser Control
    openBrowser: (accountId) => ipcRenderer.invoke('account:open-browser', accountId),
    closeBrowser: (accountId) => ipcRenderer.invoke('account:close-browser', accountId),
    fetchProfile: (accountId) => ipcRenderer.invoke('account:fetch-profile', accountId),
    manualLogin: (accountId) => ipcRenderer.invoke('account:manual-login', accountId),
    importCookies: (accountId, cookieText) => ipcRenderer.invoke('account:import-cookies', accountId, cookieText),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

    // Marketplace
    scrapeKeywords: (params) => ipcRenderer.invoke('marketplace:scrape-keywords', params),
    scrapeLocations: (params) => ipcRenderer.invoke('marketplace:scrape-locations', params),

    // Location Database
    getSavedLocations: () => ipcRenderer.invoke('location:get-all'),
    saveLocations: (data) => ipcRenderer.invoke('location:save-bulk', data),
    deleteLocations: (ids) => ipcRenderer.invoke('location:delete', ids),

    // Keyword History
    getKeywordHistory: () => ipcRenderer.invoke('keyword:get-history'),
    deleteKeywordHistory: (id) => ipcRenderer.invoke('keyword:delete-history', id),
    deleteKeyword: (historyId, keyword) => ipcRenderer.invoke('keyword:delete-keyword', historyId, keyword),

    // Material Builder
    openImageDialog: () => ipcRenderer.invoke('dialog:open-images'),
    openImages: () => ipcRenderer.invoke('dialog:open-images'),
    saveMaterials: (data) => ipcRenderer.invoke('material:save', data),
    getMaterials: () => ipcRenderer.invoke('material:get-all'),
    deleteAllMaterials: () => ipcRenderer.invoke('material:delete-all'),
    deleteMaterials: (ids) => ipcRenderer.invoke('material:delete', ids),

    // Progress listener (Main → Renderer)
    onProgressUpdate: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('account:progress-update', handler);
        return () => ipcRenderer.removeListener('account:progress-update', handler);
    },

    // Browser closed listener (Main → Renderer)
    onBrowserClosed: (callback) => {
        const handler = (_event, accountId) => callback(accountId);
        ipcRenderer.on('account:browser-closed', handler);
        return () => ipcRenderer.removeListener('account:browser-closed', handler);
    },

    // Dashboard
    getDashboardStats: () => ipcRenderer.invoke('dashboard:get-stats'),

    // Auto Posting Engine
    startPosting: (payload) => ipcRenderer.invoke('marketplace:start-posting', payload),
    stopPosting: () => ipcRenderer.invoke('marketplace:stop-posting'),
    getPostingHistory: () => ipcRenderer.invoke('posting:get-history'),
    clearPostingHistory: () => ipcRenderer.invoke('posting:clear-history'),
    openUrlWithSession: (params) => ipcRenderer.invoke('open-url-with-session', params),
    deleteSelectedHistory: (ids) => ipcRenderer.invoke('posting:delete-selected', ids),

    // Posting real-time listeners (Main → Renderer)
    onPostingLog: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('posting:log', handler);
        return () => ipcRenderer.removeListener('posting:log', handler);
    },
    onPostingStatus: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('posting:status', handler);
        return () => ipcRenderer.removeListener('posting:status', handler);
    },

    // License System
    activateLicense: (email, password) => ipcRenderer.invoke('license:activate', email, password),
    checkLicense: () => ipcRenderer.invoke('license:check'),
    resetHWID: () => ipcRenderer.invoke('license:reset-hwid'),
    getLicenseCache: () => ipcRenderer.invoke('license:get-cache'),
    clearLicense: () => ipcRenderer.invoke('license:clear-cache'),
    getHWID: () => ipcRenderer.invoke('license:get-hwid'),
    openUrl: (url) => ipcRenderer.invoke('license:open-url', url),
    queryTrialUsage: () => ipcRenderer.invoke('trial:query-usage'),

    // App Settings
    getSettings: () => ipcRenderer.invoke('app:get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('app:save-settings', settings),
    setFullscreen: (enabled) => ipcRenderer.invoke('app:set-fullscreen', enabled),

    // Campaign Persistence
    getCampaigns: () => ipcRenderer.invoke('campaign:get-all'),
    saveCampaigns: (campaigns) => ipcRenderer.invoke('campaign:save-all', campaigns),
});
