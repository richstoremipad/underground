const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Store = require('electron-store');
const { uploadPhotoToFB, uploadMultiplePhotos, extractFbDtsg, extractUid } = require('./uploadHelper.cjs');
const { publishListing, publishDraftListing, launchDraftToPublic, extractPhotoPaths, mapCondition, mapCategory } = require('./publishHelper.cjs');


// [INSERT SETELAH REQUIRE]

// --- [SISIPKAN INI AGAR JALAN MULUS DI TERMUX] ---
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
// -------------------------------------------------


// ==========================================
// SMART BROWSER DETECTION LOGIC
// ==========================================

let SMART_BROWSER_CONFIG = {};

if (process.platform === 'linux') {
    // Prioritas 1: Cek Chromium (Standar Termux/Debian)
    if (fs.existsSync('/usr/bin/chromium')) {
        console.log('[SYSTEM] Menggunakan Chromium System (/usr/bin/chromium)');
        SMART_BROWSER_CONFIG = { executablePath: '/usr/bin/chromium' };
    } 
    // Prioritas 2: Cek Chromium Browser (Ubuntu/Raspbian)
    else if (fs.existsSync('/usr/bin/chromium-browser')) {
        console.log('[SYSTEM] Menggunakan Chromium Browser (/usr/bin/chromium-browser)');
        SMART_BROWSER_CONFIG = { executablePath: '/usr/bin/chromium-browser' };
    }
    // Prioritas 3: Cek Google Chrome Linux
    else if (fs.existsSync('/usr/bin/google-chrome')) {
        console.log('[SYSTEM] Menggunakan Google Chrome Linux');
        SMART_BROWSER_CONFIG = { channel: 'chrome' };
    }
    else {
        console.log('[SYSTEM] Browser sistem tidak ditemukan, mencoba bundled...');
        SMART_BROWSER_CONFIG = {}; // Biarkan Playwright mencari sendiri
    }
} else {
    // Windows / Mac: Default pakai Chrome
    console.log('[SYSTEM] Mendeteksi Windows/Mac, menggunakan channel Chrome');
    SMART_BROWSER_CONFIG = { channel: 'chrome' };
}

// ============================================
// Configuration
// ============================================
const isDev = process.env.NODE_ENV === 'development';

const store = new Store({
    name: 'robotfb-accounts',
    defaults: { accounts: [], posting_history: [] },
});

const settingsStore = new Store({
    name: 'robotfb-settings',
    defaults: {
        appSettings: {
            theme: 'dark',
            autoFullscreen: false,
            language: 'id',
        },
    },
});

const campaignStore = new Store({
    name: 'robotfb-campaigns',
    defaults: { campaigns: [] },
});

let mainWindow = null;
const activeBrowsers = {}; // Track open browser instances by account ID

function generateId() {
    return 'acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function sendProgress(data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('account:progress-update', data);
    }
}

// ============================================
// URL Helpers
// ============================================
function isHomePage(href) {
    const h = href.toLowerCase();
    return (
        h.includes('/home') ||
        h.includes('facebook.com/?sk=') ||
        h.includes('facebook.com/?ref=') ||
        h.includes('facebook.com/#') ||
        h === 'https://www.facebook.com/' ||
        (h.startsWith('https://www.facebook.com') &&
            !h.includes('login') && !h.includes('checkpoint') &&
            !h.includes('challenge') && !h.includes('two_step') &&
            !h.includes('consent') && !h.includes('recover'))
    );
}

function isInterventionPage(href) {
    const h = href.toLowerCase();
    return (
        h.includes('checkpoint') || h.includes('challenge') ||
        h.includes('two_step_verification') || h.includes('consent') ||
        h.includes('recover')
    );
}

function isLoginPage(href) {
    const h = href.toLowerCase();
    return h.includes('/login') || h.includes('/welcome');
}

// ============================================
// Helper: Scrape Facebook display name
// ============================================
async function scrapeFbName(page) {
    let userName = 'Unknown';
    try {
        // Primary selector (user-provided FB class chain)
        const nameSelector = 'span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6';
        try {
            const nameElement = await page.locator(nameSelector).first();
            const extracted = await nameElement.innerText({ timeout: 5000 });
            if (extracted && extracted.trim().length > 0 && extracted.trim().length < 80) {
                userName = extracted.trim();
                return userName;
            }
        } catch { }

        // Fallback selectors
        const fallbackSelectors = [
            'span[data-testid="royal_user_name"]',
            'div[role="navigation"] a[href*="/me"] span',
            'a[aria-label="Profile"] span',
            'a[aria-label="Profil"] span',
        ];
        for (const sel of fallbackSelectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    const text = await el.textContent();
                    if (text && text.trim().length > 0 && text.trim().length < 80) {
                        userName = text.trim();
                        return userName;
                    }
                }
            } catch { }
        }

        // Final fallback: document title
        const title = await page.title();
        if (title && !title.includes('Facebook') && !title.includes('Log')) {
            const parts = title.split('|');
            if (parts[0].trim()) userName = parts[0].trim();
        }
    } catch { }
    return userName;
}

// ============================================
// Main Window
// ============================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 680,
        title: 'ROBOTFB.ID UNDERGROUND REBORN',
        icon: nativeImage.createFromPath(
            path.join(__dirname, isDev ? '../public/logo.png' : '../dist/logo.png')
        ),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        backgroundColor: '#18191A',
        show: false,
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        // Auto fullscreen if enabled in settings
        const appSettings = settingsStore.get('appSettings', {});
        if (appSettings.autoFullscreen) {
            mainWindow.setFullScreen(true);
        }
    });
    mainWindow.setMenuBarVisibility(false);
}

// ============================================
// IPC: App Settings
// ============================================
ipcMain.handle('app:get-settings', async () => {
    return settingsStore.get('appSettings', { theme: 'dark', autoFullscreen: false, language: 'id' });
});

ipcMain.handle('app:save-settings', async (_event, settings) => {
    settingsStore.set('appSettings', settings);
    return { success: true };
});

ipcMain.handle('app:set-fullscreen', async (_event, enabled) => {
    if (mainWindow) {
        mainWindow.setFullScreen(!!enabled);
    }
    return { success: true };
});

// ============================================
// IPC: Campaign Persistence
// ============================================
ipcMain.handle('campaign:get-all', async () => {
    try {
        return campaignStore.get('campaigns', []);
    } catch {
        return [];
    }
});

ipcMain.handle('campaign:save-all', async (_event, campaigns) => {
    try {
        campaignStore.set('campaigns', campaigns || []);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Get all accounts
// ============================================
ipcMain.handle('account:get-all', async () => {
    try {
        return { success: true, accounts: store.get('accounts', []) };
    } catch (error) {
        return { success: false, error: error.message, accounts: [] };
    }
});

// ============================================
// IPC: Delete account
// ============================================
ipcMain.handle('account:delete', async (_event, accountId) => {
    try {
        const accounts = store.get('accounts', []);
        const target = accounts.find((a) => a.id === accountId);
        if (target && target.cookiesPath && fs.existsSync(target.cookiesPath)) {
            try { fs.unlinkSync(target.cookiesPath); } catch { }
        }
        store.set('accounts', accounts.filter((a) => a.id !== accountId));
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Import raw UID|PASS|PROJECT text
// ============================================
ipcMain.handle('account:import-raw', async (_event, rawText) => {
    try {
        const lines = rawText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        if (lines.length === 0) {
            return { success: false, error: 'Tidak ada data yang valid.' };
        }

        const existingAccounts = store.get('accounts', []);
        const existingUids = new Set(existingAccounts.map((a) => a.uid));

        // Count how many NEW unique accounts will be imported
        let newCount = 0;
        for (const line of lines) {
            const sep = line.includes('|') ? '|' : ':';
            const uid = line.split(sep)[0]?.trim();
            if (uid && !existingUids.has(uid)) newCount++;
        }

        // ── Trial Enforcement: Account Limit ──
        if (newCount > 0) {
            const trialCheck = await checkTrialLimit('accounts', newCount);
            if (!trialCheck.allowed) {
                return { success: false, error: trialCheck.message, trial_limit: true };
            }
        }

        let imported = 0, skipped = 0;

        for (const line of lines) {
            const separator = line.includes('|') ? '|' : ':';
            const parts = line.split(separator);

            if (parts.length < 2) { skipped++; continue; }

            const uid = parts[0].trim();
            const password = parts[1].trim();
            const project = (parts[2] && parts[2].trim()) || 'General';

            if (!uid || !password) { skipped++; continue; }
            if (existingUids.has(uid)) { skipped++; continue; }

            existingAccounts.push({
                id: generateId(),
                uid,
                password,
                project,
                name: 'Unknown',
                photo: null,
                status: 'PENDING',
                cookiesPath: null,
                dateCreated: new Date().toISOString(),
                lastChecked: null,
            });

            existingUids.add(uid);
            imported++;
        }

        store.set('accounts', existingAccounts);
        return { success: true, imported, skipped, total: existingAccounts.length };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Verify selected accounts (Playwright — Headed)
// ============================================
ipcMain.handle('account:verify-selected', async (_event, ids) => {
    let results = { verified: 0, failed: 0, total: ids.length };

    try {
        const { chromium } = require('playwright');
        const sessionDir = path.join(app.getPath('userData'), 'sessions');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        for (let i = 0; i < ids.length; i++) {
            const accountId = ids[i];
            const accounts = store.get('accounts', []);
            const account = accounts.find((a) => a.id === accountId);
            if (!account) continue;

            sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'LOGGING_IN', message: `Login ke akun ${account.uid}...` });

            let browser = null;
            try {
                browser = await chromium.launch({
                    headless: false,
                    ...SMART_BROWSER_CONFIG,
                    ignoreDefaultArgs: ['--enable-automation'],
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--start-maximized',
                        '--disable-infobars',
                        '--disable-features=IsolateOrigins,site-per-process',
                    ],
                });
                const context = await browser.newContext({ viewport: null });
                const page = await context.newPage();

                await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(1500);

                // Fill login form with multiple fallback selectors
                try {
                    await page.fill('input#email', account.uid, { timeout: 10000 });
                    await page.fill('input#pass', account.password, { timeout: 5000 });
                    // Try multiple button selectors — XPath role='button' is primary
                    try {
                        await page.click('(//*[@role="button"])[2]', { timeout: 3000 });
                    } catch {
                        try {
                            await page.click('button[name="login"]', { timeout: 3000 });
                        } catch {
                            await page.click('button[type="submit"]', { timeout: 3000 });
                        }
                    }
                } catch {
                    try {
                        await page.fill('input[name="email"]', account.uid, { timeout: 5000 });
                        await page.fill('input[name="pass"]', account.password, { timeout: 5000 });
                        try {
                            await page.click('(//*[@role="button"])[2]', { timeout: 3000 });
                        } catch {
                            try {
                                await page.click('button[name="login"]', { timeout: 3000 });
                            } catch {
                                await page.click('button[type="submit"]', { timeout: 3000 });
                            }
                        }
                    } catch { throw new Error('Gagal menemukan form login.'); }
                }

                // SMART WAIT — jeda 10 detik setelah klik login
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'WAITING_2FA', message: `Menunggu respons login ${account.uid}... (10 detik)` });

                try {
                    await page.waitForURL((url) => {
                        const href = url.href.toLowerCase();
                        return href !== 'https://www.facebook.com/' || isHomePage(href) || isInterventionPage(href);
                    }, { timeout: 30000 });
                } catch { }

                // Jeda 10 detik supaya halaman benar-benar selesai load
                await page.waitForTimeout(10000);

                let loginSuccess = false;
                let isCheckpoint = false;
                const currentUrl = page.url();

                if (isHomePage(currentUrl)) {
                    // Konfirmasi ulang — tunggu 3 detik lagi dan cek sekali lagi
                    await page.waitForTimeout(3000);
                    const confirmUrl = page.url();
                    if (isHomePage(confirmUrl) && !isLoginPage(confirmUrl)) {
                        loginSuccess = true;
                    }
                } else if (isInterventionPage(currentUrl)) {
                    console.log(`[ROBOTFB] Intervention for ${account.uid}: ${currentUrl}`);
                    sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'WAITING_USER', message: `⚠️ Selesaikan Puzzle/2FA Manual untuk ${account.uid}! (max 10 menit)` });

                    const TIMEOUT = 600000, POLL = 2000, start = Date.now();
                    while (Date.now() - start < TIMEOUT) {
                        await page.waitForTimeout(POLL);
                        try {
                            if (isHomePage(page.url())) { loginSuccess = true; break; }
                            try { if (await page.$('div[role="feed"]')) { loginSuccess = true; break; } } catch { }
                            const rem = Math.ceil((TIMEOUT - (Date.now() - start)) / 1000);
                            sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'WAITING_USER', message: `⚠️ Puzzle/2FA ${account.uid}... (sisa ${Math.floor(rem / 60)}m ${rem % 60}s)` });
                        } catch (e) { if (e.message && e.message.includes('closed')) break; }
                    }
                    if (!loginSuccess) isCheckpoint = true;
                } else {
                    // Masih di halaman lain — tunggu 5 detik lagi dan cek ulang
                    await page.waitForTimeout(5000);
                    const retry = page.url();
                    if (isHomePage(retry)) loginSuccess = true;
                    else if (isInterventionPage(retry)) isCheckpoint = true;
                }

                // Update store
                const fresh = store.get('accounts', []);
                const idx = fresh.findIndex((a) => a.id === accountId);
                if (idx === -1) { await browser.close(); continue; }

                if (loginSuccess) {
                    sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'SAVING', message: `Login berhasil! Menyimpan cookies ${account.uid}...` });

                    const cookiesPath = path.join(sessionDir, `${accountId}.json`);
                    await context.storageState({ path: cookiesPath });

                    // ONLY update status & cookies — name/photo handled by fetch-profile
                    fresh[idx].status = 'ACTIVE';
                    fresh[idx].cookiesPath = cookiesPath;
                    fresh[idx].lastChecked = new Date().toISOString();
                    results.verified++;
                } else if (isCheckpoint) {
                    fresh[idx].status = 'CHECKPOINT';
                    fresh[idx].lastChecked = new Date().toISOString();
                    results.failed++;
                } else {
                    fresh[idx].status = 'INVALID';
                    fresh[idx].lastChecked = new Date().toISOString();
                    results.failed++;
                }

                store.set('accounts', fresh);
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'DONE', message: `Selesai: ${account.uid} → ${fresh[idx].status}`, accountStatus: fresh[idx].status });

                await browser.close();
                browser = null;
                if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 2000));

            } catch (err) {
                console.error(`[ROBOTFB] Error verifying ${account.uid}:`, err.message);
                const fresh = store.get('accounts', []);
                const idx = fresh.findIndex((a) => a.id === accountId);
                if (idx !== -1) { fresh[idx].status = 'INVALID'; fresh[idx].lastChecked = new Date().toISOString(); store.set('accounts', fresh); }
                results.failed++;
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'ERROR', message: `Gagal: ${account.uid} — ${err.message}`, accountStatus: 'INVALID' });
                if (browser) { try { await browser.close(); } catch { } browser = null; }
            }
        }
    } catch (error) {
        console.error('[ROBOTFB] Verify flow error:', error.message);
        return { success: false, error: error.message, ...results };
    }

    sendProgress({ currentId: null, currentIndex: ids.length, total: ids.length, status: 'COMPLETE', message: `Selesai! ${results.verified} berhasil, ${results.failed} gagal.` });
    return { success: true, ...results };
});

// ============================================
// IPC: Open browser with saved cookies (Stealth Mode)
// ============================================
ipcMain.handle('account:open-browser', async (_event, accountId) => {
    try {
        // If already open, just report
        if (activeBrowsers[accountId]) {
            return { success: true, message: 'Browser sudah terbuka.', newStatus: 'ACTIVE', alreadyOpen: true };
        }

        const accounts = store.get('accounts', []);
        const account = accounts.find((a) => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };
        if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
            return { success: false, error: 'Cookies belum tersedia. Verifikasi akun terlebih dahulu.' };
        }

        const { chromium } = require('playwright');

        // STEALTH: Launch real Chrome, remove automation indicators
        const browser = await chromium.launch({
            headless: false,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-infobars',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });

        const context = await browser.newContext({
            viewport: null,
            storageState: account.cookiesPath,
        });
        const page = await context.newPage();

        // Remove webdriver flag
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // Track this browser instance
        activeBrowsers[accountId] = browser;

        // Listen for manual close (user clicks X on browser)
        browser.on('disconnected', () => {
            delete activeBrowsers[accountId];
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('account:browser-closed', accountId);
            }
        });

        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        const idx = accounts.findIndex((a) => a.id === accountId);

        if (isLoginPage(currentUrl)) {
            accounts[idx].status = 'INVALID';
            accounts[idx].lastChecked = new Date().toISOString();
            store.set('accounts', accounts);
            delete activeBrowsers[accountId];
            await browser.close();
            return { success: false, error: 'Cookies expired. Akun perlu login ulang.', newStatus: 'INVALID' };
        } else {
            // ONLY update status — name/photo/stats handled by fetch-profile
            accounts[idx].status = 'ACTIVE';
            accounts[idx].lastChecked = new Date().toISOString();
            store.set('accounts', accounts);
            return { success: true, message: 'Akun aktif. Browser terbuka (stealth mode).', newStatus: 'ACTIVE' };
        }
    } catch (error) {
        delete activeBrowsers[accountId];
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Close browser for an account
// ============================================
ipcMain.handle('account:close-browser', async (_event, accountId) => {
    try {
        const browser = activeBrowsers[accountId];
        if (browser) {
            await browser.close();
            delete activeBrowsers[accountId];
        }
        return { success: true };
    } catch (error) {
        delete activeBrowsers[accountId];
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Manual Login (User logs in manually, cookies saved on close)
// ============================================
ipcMain.handle('account:manual-login', async (_event, accountId) => {
    try {
        const accounts = store.get('accounts', []);
        const account = accounts.find((a) => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };

        const { chromium } = require('playwright');
        const sessionDir = path.join(app.getPath('userData'), 'sessions');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        // Use chromium.launch() + newContext() — same approach as working auto-login
        const browser = await chromium.launch({
            headless: false,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-infobars',
                '--start-maximized',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });

        const context = await browser.newContext({ viewport: null });
        const page = await context.newPage();

        // Remove webdriver flag
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // Navigate to /settings — this will REDIRECT to login page if not logged in
        // This prevents false-positive "already logged in" detection
        await page.goto('https://www.facebook.com/settings', { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Poll: wait for user to manually login
        // We detect login by checking if URL has LEFT the login page
        let loginSuccess = false;
        let cookiesSaved = false;
        let browserClosed = false;

        browser.on('disconnected', () => { browserClosed = true; });

        // Poll every 3 seconds while browser is open, max 30 minutes
        const MAX_WAIT = 30 * 60 * 1000;
        const POLL_INTERVAL = 3000;
        const startTime = Date.now();

        while (!browserClosed && (Date.now() - startTime) < MAX_WAIT) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL));
            if (browserClosed) break;

            if (!cookiesSaved) {
                try {
                    const openPages = context.pages();
                    if (openPages.length === 0) break;
                    const currentPage = openPages[openPages.length - 1];
                    const currentUrl = currentPage.url().toLowerCase();

                    // Detect: URL is NO LONGER the login page (user has logged in)
                    const isStillOnLogin = currentUrl.includes('login') || currentUrl.includes('/checkpoint') || currentUrl === 'https://www.facebook.com/' || currentUrl === 'https://www.facebook.com';

                    if (!isStillOnLogin && currentUrl.includes('facebook.com')) {
                        console.log(`[MANUAL-LOGIN] Login detected! URL: ${currentUrl}`);

                        // Jeda 10 detik setelah login terdeteksi
                        console.log(`[MANUAL-LOGIN] Menunggu 10 detik...`);
                        await new Promise((r) => setTimeout(r, 10000));
                        if (browserClosed) break;

                        // Navigate ke /me untuk konfirmasi + load cookies lengkap
                        console.log(`[MANUAL-LOGIN] Navigasi ke /me...`);
                        try {
                            await currentPage.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 15000 });
                        } catch { }

                        // Jeda 5 detik lagi
                        console.log(`[MANUAL-LOGIN] Menunggu 5 detik di /me...`);
                        await new Promise((r) => setTimeout(r, 5000));
                        if (browserClosed) break;

                        // Save cookies
                        const cookiesPath = path.join(sessionDir, `${accountId}.json`);
                        await context.storageState({ path: cookiesPath });
                        cookiesSaved = true;
                        loginSuccess = true;

                        const fresh = store.get('accounts', []);
                        const idx = fresh.findIndex((a) => a.id === accountId);
                        if (idx !== -1) {
                            fresh[idx].status = 'ACTIVE';
                            fresh[idx].cookiesPath = cookiesPath;
                            fresh[idx].lastChecked = new Date().toISOString();
                            store.set('accounts', fresh);
                        }

                        console.log(`[MANUAL-LOGIN] ${account.uid} → Cookies saved!`);

                        // Tutup browser otomatis
                        try { await browser.close(); } catch { }
                        break;
                    }
                } catch (pollErr) {
                    if (pollErr.message && (pollErr.message.includes('closed') || pollErr.message.includes('destroyed'))) break;
                }
            }
        }

        // If timeout reached and browser still open, close it
        if (!browserClosed) {
            try { await browser.close(); } catch { }
        }

        // Notify renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account:manual-login-closed', {
                accountId,
                success: loginSuccess,
                cookiesSaved,
            });
        }

        return {
            success: loginSuccess,
            cookiesSaved,
            message: loginSuccess
                ? 'Login berhasil! Cookies tersimpan. Browser ditutup.'
                : 'Browser ditutup. Cookies tidak tersimpan (login belum berhasil).',
            newStatus: loginSuccess ? 'ACTIVE' : undefined,
        };
    } catch (error) {
        console.error('[MANUAL-LOGIN] Error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Import Cookies (User pastes cookie text directly)
// Supports JSON array format: [{"name":"c_user","value":"...","domain":".facebook.com",...}]
// ============================================
ipcMain.handle('account:import-cookies', async (_event, accountId, cookieText) => {
    try {
        const accounts = store.get('accounts', []);
        const account = accounts.find((a) => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };

        const { chromium } = require('playwright');
        const sessionDir = path.join(app.getPath('userData'), 'sessions');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        // Parse the cookie text
        let parsedCookies = [];
        const trimmed = cookieText.trim();

        // Map sameSite values from Cookie-Editor format to Playwright format
        const mapSameSite = (val) => {
            if (!val) return 'None';
            const lower = String(val).toLowerCase();
            if (lower === 'no_restriction' || lower === 'none' || lower === 'unspecified') return 'None';
            if (lower === 'lax') return 'Lax';
            if (lower === 'strict') return 'Strict';
            return 'None';
        };

        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            // JSON format — Cookie-Editor exports this format
            const raw = JSON.parse(trimmed);
            const arr = Array.isArray(raw) ? raw : [raw];

            parsedCookies = arr
                .filter(c => (c.name || c.Name) && (c.value !== undefined || c.Value !== undefined))
                .map(c => {
                    // Cookie-Editor uses expirationDate (unix timestamp in seconds)
                    let expires = -1;
                    if (c.expirationDate) expires = Number(c.expirationDate);
                    else if (c.expires) expires = Number(c.expires);
                    else if (c.Expires) expires = Number(c.Expires);

                    // If session cookie (no expiry), set to -1 (Playwright session cookie)
                    if (!expires || isNaN(expires) || expires <= 0) expires = -1;

                    return {
                        name: String(c.name || c.Name),
                        value: String(c.value ?? c.Value ?? ''),
                        domain: String(c.domain || c.Domain || '.facebook.com'),
                        path: String(c.path || c.Path || '/'),
                        expires,
                        httpOnly: Boolean(c.httpOnly ?? c.HttpOnly ?? false),
                        secure: Boolean(c.secure ?? c.Secure ?? true),
                        sameSite: mapSameSite(c.sameSite || c.SameSite),
                    };
                });
        } else {
            // Netscape/text format: domain \t flag \t path \t secure \t expiry \t name \t value
            const lines = trimmed.split('\n').filter(l => l.trim() && !l.startsWith('#'));
            for (const line of lines) {
                const parts = line.split('\t');
                if (parts.length >= 7) {
                    parsedCookies.push({
                        name: parts[5].trim(),
                        value: parts[6] ? parts[6].trim() : '',
                        domain: parts[0].trim(),
                        path: parts[2].trim(),
                        expires: parseInt(parts[4]) || -1,
                        httpOnly: false,
                        secure: parts[3].trim().toUpperCase() === 'TRUE',
                        sameSite: 'None',
                    });
                }
            }
        }

        if (parsedCookies.length === 0) {
            return { success: false, error: 'Tidak ada cookies yang valid ditemukan. Pastikan format JSON dari Cookie-Editor.' };
        }

        console.log(`[IMPORT-COOKIES] Parsed ${parsedCookies.length} cookies for ${account.uid}`);

        // Save to storageState file
        const storageState = {
            cookies: parsedCookies,
            origins: [],
        };

        const cookiesPath = path.join(sessionDir, `${accountId}.json`);
        fs.writeFileSync(cookiesPath, JSON.stringify(storageState, null, 2), 'utf-8');

        // Validate: open VISIBLE Chrome, inject cookies, and check login
        let isValid = false;

        try {
            const browser = await chromium.launch({
                headless: false,
                ...SMART_BROWSER_CONFIG,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--disable-infobars',
                    '--start-maximized',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                ],
            });

            const context = await browser.newContext({ viewport: null });

            // Inject cookies via addCookies (more reliable than storageState for Cookie-Editor format)
            await context.addCookies(parsedCookies);

            const page = await context.newPage();

            // Remove webdriver flag
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            // Navigate to /me to verify cookies work
            console.log(`[IMPORT-COOKIES] Navigasi ke facebook.com/me...`);
            await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 20000 });

            // Jeda 10 detik biar halaman fully load
            console.log(`[IMPORT-COOKIES] Menunggu 10 detik untuk validasi...`);
            await page.waitForTimeout(10000);

            const currentUrl = page.url().toLowerCase();
            console.log(`[IMPORT-COOKIES] URL setelah inject: ${currentUrl}`);

            // Check: if URL is NOT login/checkpoint, cookies work!
            const isLoginUrl = currentUrl.includes('login') || currentUrl.includes('/checkpoint');
            const isFacebook = currentUrl.includes('facebook.com');
            isValid = isFacebook && !isLoginUrl;

            if (isValid) {
                // Re-export storageState from the working browser (paling akurat)
                await context.storageState({ path: cookiesPath });
                console.log(`[IMPORT-COOKIES] ✅ Cookies valid! Disimpan ulang dari browser.`);
            } else {
                console.log(`[IMPORT-COOKIES] ❌ Cookies invalid — masih di login page.`);
            }

            await browser.close();
        } catch (valErr) {
            console.error('[IMPORT-COOKIES] Validation error:', valErr.message);
        }

        // Update account
        const fresh = store.get('accounts', []);
        const idx = fresh.findIndex((a) => a.id === accountId);
        if (idx !== -1) {
            fresh[idx].cookiesPath = cookiesPath;
            fresh[idx].status = isValid ? 'ACTIVE' : 'PENDING';
            fresh[idx].lastChecked = new Date().toISOString();
            store.set('accounts', fresh);
        }

        return {
            success: true,
            isValid,
            cookieCount: parsedCookies.length,
            message: isValid
                ? `✅ ${parsedCookies.length} cookies berhasil diimpor dan login terverifikasi! Akun aktif.`
                : `❌ ${parsedCookies.length} cookies tersimpan, tapi login gagal. Cek ulang cookies.`,
            newStatus: isValid ? 'ACTIVE' : 'PENDING',
        };
    } catch (error) {
        console.error('[IMPORT-COOKIES] Error:', error.message);
        return { success: false, error: `Gagal parse cookies: ${error.message}` };
    }
});


// ============================================
// IPC: Open URL in system browser
// ============================================
ipcMain.handle('app:open-external', async (_event, url) => {
    if (url && typeof url === 'string') {
        await shell.openExternal(url);
    }
});

// ============================================
// IPC: Validate selected cookies (Headless bulk check)
// ============================================
ipcMain.handle('account:validate-selected', async (_event, ids) => {
    let results = { active: 0, invalid: 0, skipped: 0, total: ids.length };

    try {
        const { chromium } = require('playwright');

        for (let i = 0; i < ids.length; i++) {
            const accountId = ids[i];
            const accounts = store.get('accounts', []);
            const account = accounts.find((a) => a.id === accountId);
            if (!account) { results.skipped++; continue; }

            sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'VALIDATING', message: `Mengecek cookies ${account.uid}... (${i + 1}/${ids.length})` });

            if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
                results.skipped++;
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'DONE', message: `Dilewati: ${account.uid} (belum ada cookies)`, accountStatus: account.status });
                continue;
            }

            let browser = null;
            try {
                browser = await chromium.launch({
                    headless: true,
                    ...SMART_BROWSER_CONFIG,
                    ignoreDefaultArgs: ['--enable-automation'],
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--no-sandbox',
                        '--disable-infobars',
                        '--disable-features=IsolateOrigins,site-per-process',
                    ],
                });
                const context = await browser.newContext({ storageState: account.cookiesPath });
                const page = await context.newPage();

                await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
                await page.waitForTimeout(2000);

                const url = page.url();
                const idx = accounts.findIndex((a) => a.id === accountId);

                if (isLoginPage(url) || isInterventionPage(url)) {
                    accounts[idx].status = 'INVALID';
                    accounts[idx].lastChecked = new Date().toISOString();
                    results.invalid++;
                    sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'DONE', message: `${account.uid} → INVALID (cookies expired)`, accountStatus: 'INVALID' });
                } else {
                    // ONLY update status — name/photo/stats handled by fetch-profile
                    accounts[idx].status = 'ACTIVE';
                    accounts[idx].lastChecked = new Date().toISOString();
                    results.active++;
                    sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'DONE', message: `${account.uid} → ACTIVE ✓`, accountStatus: 'ACTIVE' });
                }

                store.set('accounts', accounts);
                await browser.close();
                browser = null;
            } catch (err) {
                if (browser) { try { await browser.close(); } catch { } }
                results.invalid++;
                sendProgress({ currentId: accountId, currentIndex: i + 1, total: ids.length, status: 'ERROR', message: `${account.uid} → Error: ${err.message}`, accountStatus: 'INVALID' });
            }

            if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 500));
        }
    } catch (error) {
        return { success: false, error: error.message, ...results };
    }

    sendProgress({ currentId: null, currentIndex: ids.length, total: ids.length, status: 'COMPLETE', message: `Validasi selesai! ${results.active} aktif, ${results.invalid} invalid, ${results.skipped} dilewati.` });
    return { success: true, ...results };
});

// ============================================
// IPC: Fetch Account Profile (Dedicated /me extractor)
// ============================================
ipcMain.handle('account:fetch-profile', async (_event, accountId) => {
    let browser = null;
    try {
        const { chromium } = require('playwright');
        const accounts = store.get('accounts') || [];
        const account = accounts.find((a) => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };

        const fs = require('fs');
        if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
            return { success: false, error: 'Cookies belum tersedia. Login/verifikasi akun terlebih dahulu.' };
        }

        browser = await chromium.launch({
            headless: true,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-infobars',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });
        const context = await browser.newContext({ storageState: account.cookiesPath });
        const page = await context.newPage();

        // Navigasi ke /me — Facebook akan redirect ke URL profil user
        await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000); // Tunggu redirect + React render

        const profileData = await page.evaluate(() => {
            let name = '';
            let pic = '';

            // --- STRATEGI 1: BEDAH JEROAN SCRIPT (The Ultimate Surgeon) ---
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const text = script.textContent;

                if (text.includes('"actor":{"__typename":"User"') || text.includes('EAA')) {
                    // 1. Ekstrak Nama
                    if (!name) {
                        const nameMatch = text.match(/"name":"([^"]+)"/);
                        if (nameMatch && nameMatch[1].length > 2 && !nameMatch[1].includes('Facebook')) {
                            name = nameMatch[1];
                        }
                    }

                    // 2. Ekstrak Foto Profil (URL scontent yang di-escape)
                    if (!pic) {
                        const picMatch = text.match(/"uri":"(https:\\\/\\\/scontent[^"]+)"/) || text.match(/"uri":"(https:\/\/scontent[^"]+)"/);
                        if (picMatch) {
                            pic = picMatch[1].replace(/\\/g, '');
                        }
                    }
                }
                if (name && pic) break;
            }

            // --- STRATEGI 2: SANITASI TITLE (Jika Jeroan Gagal) ---
            if (!name) {
                let docTitle = document.title;
                // HAPUS ANGKA NOTIFIKASI! "(2) Facebook" → "Facebook"
                docTitle = docTitle.replace(/^\(\d+\)\s*/, '');

                if (docTitle.includes(' | Facebook')) {
                    name = docTitle.split(' | Facebook')[0].trim();
                } else if (docTitle.includes(' - Facebook')) {
                    name = docTitle.split(' - Facebook')[0].trim();
                } else if (docTitle !== 'Facebook') {
                    name = docTitle;
                }
            }

            // --- STRATEGI 3: FALLBACK FOTO DOM ---
            if (!pic || !pic.includes('scontent')) {
                const imgNode = document.querySelector('svg[role="img"] image');
                if (imgNode) {
                    pic = imgNode.getAttribute('xlink:href') || '';
                }
            }

            // --- SANITASI AKHIR ---
            if (!name || name.toLowerCase().includes('facebook') || name.toLowerCase().includes('notifikasi') || name.toLowerCase().includes('cari teman')) {
                name = 'Unknown Account';
            }

            return { name, pic };
        });

        console.log(`[FETCH-PROFILE] ${account.uid} → name="${profileData.name}", pic="${profileData.pic ? 'YES' : 'NO'}"`);

        // --- TAHAP 2: AMBIL STATISTIK DARI MOBILE FACEBOOK (THE BYPASS) ---
        let statsData = { activeListings: '0', unreadChats: '0', marketplaceAccess: true };
        try {
            await page.goto('https://m.facebook.com/marketplace/you/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            // Check if redirected to ineligible page
            const currentUrl = page.url();
            if (currentUrl.includes('/ineligible')) {
                console.log(`[FETCH-PROFILE] ${account.uid} → MARKETPLACE INELIGIBLE`);
                statsData = { activeListings: 'N/A', unreadChats: 'N/A', marketplaceAccess: false };
            } else {
                statsData = await page.evaluate(() => {
                    let activeListings = '0';
                    let unreadChats = '0';

                    const bodyText = document.body.innerText;

                    // 1. Ekstrak Obrolan ("0\nObrolan yang perlu dijawab")
                    const chatMatch = bodyText.match(/(\d+\+?)\s*(?:Obrolan yang perlu|Chats to answer)/i);
                    if (chatMatch) unreadChats = chatMatch[1];

                    // 2. Ekstrak Tawaran Aktif ("20+\nAktif & sedang diproses")
                    const activeMatch = bodyText.match(/(\d+\+?)\s*(?:Tawaran aktif|Active listings|Aktif & sedang diproses)/i);
                    if (activeMatch) activeListings = activeMatch[1];

                    return { activeListings, unreadChats, marketplaceAccess: true };
                });
            }
            console.log(`[FETCH-PROFILE] ${account.uid} → listings=${statsData.activeListings}, chats=${statsData.unreadChats}, mpAccess=${statsData.marketplaceAccess}`);
        } catch (statsErr) {
            console.warn(`[FETCH-PROFILE] Stats extraction failed for ${account.uid}:`, statsErr.message);
        }

        await browser.close();
        browser = null;

        // Update electron-store (always save stats, conditionally save profile)
        const idx = accounts.findIndex((a) => a.id === accountId);
        if (idx !== -1) {
            accounts[idx].activeListings = statsData.activeListings;
            accounts[idx].unreadChats = statsData.unreadChats;
            accounts[idx].marketplaceAccess = statsData.marketplaceAccess;

            if (profileData.name && profileData.name !== 'Unknown' && profileData.name !== 'Unknown Account') {
                accounts[idx].name = profileData.name;
                if (profileData.pic) accounts[idx].profilePicture = profileData.pic;
            }
            store.set('accounts', accounts);
        }

        if (profileData.name && profileData.name !== 'Unknown' && profileData.name !== 'Unknown Account') {
            return { success: true, data: { ...profileData, ...statsData } };
        } else {
            return { success: false, error: 'Gagal menemukan elemen profil. Pastikan akun sudah login.' };
        }
    } catch (error) {
        if (browser) { try { await browser.close(); } catch { } }
        console.error('[FETCH-PROFILE] Error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Bulk Fetch Profile (sequential, with progress)
// ============================================
ipcMain.handle('account:fetch-profile-bulk', async (event, ids) => {
    let totalSuccess = 0, totalFailed = 0;
    const total = ids.length;

    for (let i = 0; i < ids.length; i++) {
        const accountId = ids[i];
        const accounts = store.get('accounts', []);
        const account = accounts.find(a => a.id === accountId);

        // Send progress to renderer
        mainWindow?.webContents.send('account:progress-update', {
            status: 'SCRAPING',
            message: `📸 Fetching profil ${i + 1}/${total}: ${account?.uid || accountId}`,
            currentIndex: i + 1,
            total,
            currentId: accountId,
        });

        try {
            // Reuse the single fetch-profile logic via internal call
            const result = await ipcMain.handle.__fetchProfileInternal(accountId);
            if (result.success) totalSuccess++;
            else totalFailed++;
        } catch {
            totalFailed++;
        }

        // Small delay between fetches to avoid rate limiting
        if (i < ids.length - 1) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    // Send completion
    mainWindow?.webContents.send('account:progress-update', {
        status: 'COMPLETE',
        message: `✅ Selesai! ${totalSuccess} berhasil, ${totalFailed} gagal.`,
        currentIndex: total,
        total,
    });

    return { success: true, totalSuccess, totalFailed, total };
});

// Internal helper to reuse fetch-profile logic
ipcMain.handle.__fetchProfileInternal = async (accountId) => {
    let browser = null;
    try {
        const { chromium } = require('playwright');
        const accounts = store.get('accounts') || [];
        const account = accounts.find(a => a.id === accountId);
        if (!account) return { success: false, error: 'Akun tidak ditemukan.' };

        if (!account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
            return { success: false, error: 'Cookies belum tersedia.' };
        }

        browser = await chromium.launch({
            headless: true, ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-infobars'],
        });
        const context = await browser.newContext({ storageState: account.cookiesPath });
        const page = await context.newPage();

        await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);

        const profileData = await page.evaluate(() => {
            let name = '', pic = '';
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const text = script.textContent;
                if (text.includes('"actor":{"__typename":"User"') || text.includes('EAA')) {
                    if (!name) {
                        const m = text.match(/"name":"([^"]+)"/);
                        if (m && m[1].length > 2 && !m[1].includes('Facebook')) name = m[1];
                    }
                    if (!pic) {
                        const m = text.match(/"uri":"(https:\\\/\\\/scontent[^"]+)"/) || text.match(/"uri":"(https:\/\/scontent[^"]+)"/);
                        if (m) pic = m[1].replace(/\\/g, '');
                    }
                }
                if (name && pic) break;
            }
            if (!name) {
                let t = document.title.replace(/^\(\d+\)\s*/, '');
                if (t.includes(' | Facebook')) name = t.split(' | Facebook')[0].trim();
                else if (t.includes(' - Facebook')) name = t.split(' - Facebook')[0].trim();
                else if (t !== 'Facebook') name = t;
            }
            if (!pic || !pic.includes('scontent')) {
                const img = document.querySelector('svg[role="img"] image');
                if (img) pic = img.getAttribute('xlink:href') || '';
            }
            if (!name || name.toLowerCase().includes('facebook')) name = 'Unknown Account';
            return { name, pic };
        });

        // Stats
        let statsData = { activeListings: '0', unreadChats: '0', marketplaceAccess: true };
        try {
            await page.goto('https://m.facebook.com/marketplace/you/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            const currentUrl = page.url();
            if (currentUrl.includes('/ineligible')) {
                statsData = { activeListings: 'N/A', unreadChats: 'N/A', marketplaceAccess: false };
            } else {
                statsData = await page.evaluate(() => {
                    const bodyText = document.body.innerText;
                    const chat = bodyText.match(/(\d+\+?)\s*(?:Obrolan yang perlu|Chats to answer)/i);
                    const active = bodyText.match(/(\d+\+?)\s*(?:Tawaran aktif|Active listings|Aktif & sedang diproses)/i);
                    return { activeListings: active?.[1] || '0', unreadChats: chat?.[1] || '0', marketplaceAccess: true };
                });
            }
        } catch { }

        await browser.close();
        browser = null;

        const freshAccounts = store.get('accounts', []);
        const idx = freshAccounts.findIndex(a => a.id === accountId);
        if (idx !== -1) {
            freshAccounts[idx].activeListings = statsData.activeListings;
            freshAccounts[idx].unreadChats = statsData.unreadChats;
            freshAccounts[idx].marketplaceAccess = statsData.marketplaceAccess;
            if (profileData.name && profileData.name !== 'Unknown' && profileData.name !== 'Unknown Account') {
                freshAccounts[idx].name = profileData.name;
                if (profileData.pic) freshAccounts[idx].profilePicture = profileData.pic;
            }
            store.set('accounts', freshAccounts);
        }

        return profileData.name && profileData.name !== 'Unknown Account'
            ? { success: true, data: { ...profileData, ...statsData } }
            : { success: false, error: 'Gagal extract profil' };
    } catch (err) {
        if (browser) try { await browser.close(); } catch { }
        return { success: false, error: err.message };
    }
};

// ============================================
// IPC: Bulk Update Project
// ============================================
ipcMain.handle('account:update-project', async (_event, ids, newProject) => {
    try {
        const accounts = store.get('accounts', []);
        const idSet = new Set(ids);
        let updated = 0;
        for (const acc of accounts) {
            if (idSet.has(acc.id)) {
                acc.project = newProject || 'General';
                updated++;
            }
        }
        store.set('accounts', accounts);
        return { success: true, updated };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// IPC: Open CSV File Dialog
// ============================================
ipcMain.handle('dialog:open-csv', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Pilih File CSV',
            filters: [{ name: 'CSV Files', extensions: ['csv', 'txt'] }],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths.length) {
            return { success: false, canceled: true };
        }
        const content = fs.readFileSync(result.filePaths[0], 'utf-8');
        return { success: true, content, filePath: result.filePaths[0] };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// Helper: Title Case formatter
// ============================================
function toTitleCase(str) {
    return str.replace(/\w\S*/g, (txt) => {
        return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
    });
}

// ============================================
// IPC: Marketplace – Scrape Keywords (Token Grabber + Multi-Batch)
// ============================================
ipcMain.handle('marketplace:scrape-keywords', async (event, { keywords: rawInput, mode }) => {
    let tokenBrowser = null;

    try {
        if (!rawInput || !rawInput.trim()) {
            return { success: false, error: 'Kata kunci tidak boleh kosong.' };
        }

        // Parse input: split by comma or newline, trim, deduplicate
        const rootKeywords = [...new Set(
            rawInput.split(/[,\n]+/).map((k) => k.trim()).filter((k) => k.length > 0)
        )];
        if (rootKeywords.length === 0) {
            return { success: false, error: 'Tidak ada kata kunci valid ditemukan.' };
        }

        const startTime = performance.now();

        const accounts = store.get('accounts', []);
        const activeAccount = accounts.find((a) => a.status === 'ACTIVE' && a.cookiesPath && fs.existsSync(a.cookiesPath));
        if (!activeAccount) {
            return { success: false, error: 'Harap login minimal 1 akun di menu Manajemen Akun dulu!' };
        }

        const { chromium } = require('playwright');

        // ── PHASE 1: TOKEN GRABBER ──
        sendProgress({
            currentId: 'keyword-scrape',
            currentIndex: 0,
            total: 1,
            status: 'SCRAPING',
            message: 'Menginisialisasi engine pencarian...',
        });

        console.log(`[KEYWORDS] Phase 1: Token grab for ${activeAccount.uid}...`);
        tokenBrowser = await chromium.launch({
            headless: true,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-infobars',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });
        const browserContext = await tokenBrowser.newContext({
            storageState: activeAccount.cookiesPath,
        });
        const page = await browserContext.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        if (isLoginPage(currentUrl)) {
            await tokenBrowser.close();
            return { success: false, error: 'Cookies expired. Login ulang akun ini di Manajemen Akun.' };
        }

        const fbDtsg = await page.evaluate(() => {
            if (window.DTSGInitData && window.DTSGInitData.token) return window.DTSGInitData.token;
            try { if (typeof require === 'function') { const m = require('DTSGInitData'); if (m && m.token) return m.token; } } catch { }
            const input = document.querySelector('input[name="fb_dtsg"]');
            if (input) return input.value;
            const html = document.documentElement.innerHTML;
            const m1 = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
            if (m1) return m1[1];
            const m2 = html.match(/fb_dtsg.*?value="([^"]+)"/);
            if (m2) return m2[1];
            return null;
        });

        await tokenBrowser.close();
        tokenBrowser = null;
        console.log(`[KEYWORDS] Token: ${fbDtsg ? fbDtsg.substring(0, 20) + '...' : 'NULL'}`);

        if (!fbDtsg) {
            return { success: false, error: 'Gagal membangun koneksi aman. Coba login ulang akun ini di Manajemen Akun.' };
        }

        // ── PHASE 2: MULTI-KEYWORD BATCH ──
        console.log(`[KEYWORDS] Phase 2: Batch processing ${rootKeywords.length} root keywords...`);

        const requestContext = await (require('playwright')).request.newContext({
            storageState: activeAccount.cookiesPath,
            extraHTTPHeaders: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.facebook.com',
                'Referer': 'https://www.facebook.com/marketplace/',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
            },
        });

        // Helper: single API request
        async function fetchKeywordsAPI(query) {
            try {
                const response = await requestContext.post('https://www.facebook.com/api/graphql/', {
                    form: {
                        fb_dtsg: fbDtsg,
                        doc_id: '9807803949296946',
                        variables: JSON.stringify({ query: query, count: 10 }),
                    },
                    timeout: 15000,
                });
                if (response.status() !== 200) return [];
                let text = await response.text();
                text = text.replace('for (;;);', '');
                const json = JSON.parse(text);
                const suggestions = json?.data?.viewer?.marketplace_search_typeahead_suggestions_v2 || [];
                return suggestions.map((item) => item.query).filter(Boolean);
            } catch (e) {
                console.error(`[KEYWORDS] Error "${query}":`, e.message);
                return [];
            }
        }

        // Helper: concurrency limiter
        async function batchWithConcurrency(tasks, limit) {
            const results = [];
            const executing = new Set();
            for (const task of tasks) {
                const p = task().then((r) => { executing.delete(p); return r; });
                executing.add(p);
                results.push(p);
                if (executing.size >= limit) await Promise.race(executing);
            }
            return Promise.all(results);
        }

        // Build suffix list for A-Z mode
        const suffixes = mode === 'A-Z' ? (() => {
            const s = [' '];
            for (let c = 97; c <= 122; c++) s.push(' ' + String.fromCharCode(c));
            for (let n = 0; n <= 9; n++) s.push(' ' + n);
            return s;
        })() : null;

        const totalSteps = rootKeywords.length * (mode === 'A-Z' ? 37 : 1);
        let globalStep = 0;

        const allResults = []; // { rootKeyword, keyword }
        const breakdown = {}; // rootKeyword -> count

        for (let ri = 0; ri < rootKeywords.length; ri++) {
            const root = rootKeywords[ri];
            let rootResults = [];

            if (mode === 'A-Z') {
                const tasks = suffixes.map((suffix) => () => {
                    globalStep++;
                    sendProgress({
                        currentId: 'keyword-scrape',
                        currentIndex: globalStep,
                        total: totalSteps,
                        status: 'SCRAPING',
                        message: `Menganalisis "${root}${suffix.trim() ? suffix : ''}" ... [${ri + 1}/${rootKeywords.length}] (${globalStep}/${totalSteps})`,
                    });
                    return fetchKeywordsAPI(root + suffix);
                });
                const batchResults = await batchWithConcurrency(tasks, 5);
                rootResults = batchResults.flat();
            } else {
                globalStep++;
                sendProgress({
                    currentId: 'keyword-scrape',
                    currentIndex: globalStep,
                    total: totalSteps,
                    status: 'SCRAPING',
                    message: `Menganalisis algoritma saran kata "${root}" ... [${ri + 1}/${rootKeywords.length}]`,
                });
                rootResults = await fetchKeywordsAPI(root);
            }

            // Deduplicate per root + Title Case
            const uniqueRoot = [...new Set(rootResults.map((k) => toTitleCase(k.trim())))].filter((k) => k.length > 0);
            uniqueRoot.forEach((kw) => allResults.push({ rootKeyword: root, keyword: kw }));
            breakdown[root] = uniqueRoot.length;
            console.log(`[KEYWORDS] "${root}" → ${uniqueRoot.length} unique results`);
        }

        await requestContext.dispose();

        // Global dedup by keyword (keep first rootKeyword)
        const seen = new Set();
        const dedupResults = [];
        for (const item of allResults) {
            if (!seen.has(item.keyword)) {
                seen.add(item.keyword);
                dedupResults.push(item);
            }
        }
        dedupResults.sort((a, b) => a.keyword.localeCompare(b.keyword));

        const executionTime = ((performance.now() - startTime) / 1000).toFixed(1);

        sendProgress({
            currentId: 'keyword-scrape',
            currentIndex: totalSteps,
            total: totalSteps,
            status: 'COMPLETE',
            message: `Selesai! Ditemukan ${dedupResults.length} kata kunci unik dalam ${executionTime} detik.`,
        });

        console.log(`[KEYWORDS] DONE: ${dedupResults.length} keywords in ${executionTime}s`);

        // ── AUTO-SAVE to keyword_history ──
        const history = store.get('keyword_history', []);
        const dateStr = new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });

        // Group results by rootKeyword and save each as a history entry
        const grouped = {};
        for (const item of dedupResults) {
            if (!grouped[item.rootKeyword]) grouped[item.rootKeyword] = [];
            grouped[item.rootKeyword].push(item.keyword);
        }

        const newHistoryIds = [];
        for (const [root, kws] of Object.entries(grouped)) {
            const entry = {
                id: Date.now() + '_' + Math.random().toString(36).substring(2, 6),
                rootKeyword: root,
                total: kws.length,
                date: dateStr,
                keywords: kws,
            };
            history.unshift(entry);
            newHistoryIds.push(entry.id);
        }
        store.set('keyword_history', history);
        console.log(`[KEYWORDS] Auto-saved ${newHistoryIds.length} history entries`);

        return {
            success: true,
            results: dedupResults,
            newHistoryIds,
            report: {
                rootKeywords: rootKeywords.length,
                totalFound: dedupResults.length,
                executionTime: parseFloat(executionTime),
                breakdown,
            },
        };
    } catch (error) {
        if (tokenBrowser) {
            try { await tokenBrowser.close(); } catch { }
        }
        console.error('[KEYWORDS] Fatal error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Keyword History CRUD (Persistent via electron-store)
// ============================================
ipcMain.handle('keyword:get-history', async () => {
    return store.get('keyword_history', []);
});

ipcMain.handle('keyword:delete-history', async (event, id) => {
    const history = store.get('keyword_history', []);
    const filtered = history.filter((h) => h.id !== id);
    store.set('keyword_history', filtered);
    console.log(`[KEYWORDS DB] Deleted history "${id}". Remaining: ${filtered.length}`);
    return { success: true, remaining: filtered.length };
});

// ============================================
// IPC: Delete individual keyword from history entry
// ============================================
ipcMain.handle('keyword:delete-keyword', async (_event, historyId, keyword) => {
    try {
        const history = store.get('keyword_history', []);
        const entry = history.find(h => h.id === historyId);
        if (!entry) return { success: false, error: 'Entry not found' };

        entry.keywords = entry.keywords.filter(kw => kw !== keyword);
        entry.total = entry.keywords.length;

        // If all keywords removed, delete the entire entry
        if (entry.keywords.length === 0) {
            const idx = history.indexOf(entry);
            history.splice(idx, 1);
        }

        store.set('keyword_history', history);
        console.log(`[KEYWORDS DB] Deleted keyword "${keyword}" from "${historyId}". Remaining: ${entry.keywords.length}`);
        return { success: true, remaining: entry.keywords.length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// IPC: Material Builder (Dialog + Save)
// ============================================
ipcMain.handle('dialog:open-images', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Pilih Foto Produk (Maks 20)',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    if (canceled) return [];
    return filePaths; // Array of absolute paths (e.g. C:\Users\...\foto.jpg)
});

ipcMain.handle('material:save', async (event, materials) => {
    if (!Array.isArray(materials) || materials.length === 0) {
        return { success: false, error: 'Tidak ada data.' };
    }

    // ── Trial Enforcement: Material Limit ──
    const trialCheck = await checkTrialLimit('materials', materials.length);
    if (!trialCheck.allowed) {
        return { success: false, error: trialCheck.message, trial_limit: true };
    }

    const existing = store.get('posting_materials', []);
    const merged = [...existing, ...materials];
    store.set('posting_materials', merged);
    console.log(`[MATERIALS] Saved ${materials.length} items. Total: ${merged.length}`);
    return { success: true, added: materials.length, total: merged.length };
});

ipcMain.handle('material:get-all', async () => {
    return store.get('posting_materials', []);
});

ipcMain.handle('material:delete-all', async () => {
    store.set('posting_materials', []);
    return { success: true };
});

ipcMain.handle('material:delete', async (event, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) {
        return { success: false, error: 'Tidak ada ID.' };
    }
    const idSet = new Set(ids);
    const existing = store.get('posting_materials', []);
    const filtered = existing.filter((m) => !idSet.has(m.id));
    store.set('posting_materials', filtered);
    console.log(`[MATERIALS] Deleted ${ids.length} items. Remaining: ${filtered.length}`);
    return { success: true, deleted: ids.length, remaining: filtered.length };
});

// ============================================
// IPC: Location Database CRUD (Persistent via electron-store)
// ============================================
ipcMain.handle('location:get-all', async () => {
    return store.get('saved_locations', []);
});

ipcMain.handle('location:save-bulk', async (event, newLocations) => {
    if (!Array.isArray(newLocations) || newLocations.length === 0) {
        return { success: false, error: 'Tidak ada data untuk disimpan.' };
    }
    const existing = store.get('saved_locations', []);
    const existingNames = new Set(existing.map((l) => l.fbName));

    const toAdd = newLocations.filter((loc) => !existingNames.has(loc.fbName));
    const merged = [...existing, ...toAdd];
    store.set('saved_locations', merged);
    console.log(`[LOCATIONS DB] Saved ${toAdd.length} new (${newLocations.length - toAdd.length} duplicates skipped). Total: ${merged.length}`);
    return { success: true, added: toAdd.length, total: merged.length };
});

ipcMain.handle('location:delete', async (event, ids) => {
    if (!Array.isArray(ids) || ids.length === 0) {
        return { success: false, error: 'Tidak ada data untuk dihapus.' };
    }
    const idSet = new Set(ids);
    const existing = store.get('saved_locations', []);
    const filtered = existing.filter((l) => !idSet.has(l.id));
    store.set('saved_locations', filtered);
    console.log(`[LOCATIONS DB] Deleted ${existing.length - filtered.length} locations. Remaining: ${filtered.length}`);
    return { success: true, deleted: existing.length - filtered.length, total: filtered.length };
});

// ============================================
// IPC: Marketplace – Scrape Locations (Token Grabber + API Request)
// ============================================
ipcMain.handle('marketplace:scrape-locations', async (event, { cities, province }) => {
    let tokenBrowser = null;

    try {
        if (!cities || !Array.isArray(cities) || cities.length === 0) {
            return { success: false, error: 'Daftar kota tidak boleh kosong.' };
        }

        const accounts = store.get('accounts', []);
        const activeAccount = accounts.find((a) => a.status === 'ACTIVE' && a.cookiesPath && fs.existsSync(a.cookiesPath));
        if (!activeAccount) {
            return { success: false, error: 'Harap login minimal 1 akun di menu Manajemen Akun dulu!' };
        }

        const { chromium } = require('playwright');

        // ── PHASE 1: TOKEN GRABBER ──
        sendProgress({
            currentId: 'location-scrape',
            currentIndex: 0,
            total: cities.length,
            status: 'SCRAPING',
            message: 'Menginisialisasi engine pencarian lokasi...',
        });

        console.log(`[LOCATIONS] Phase 1: Token grab for ${activeAccount.uid}...`);
        tokenBrowser = await chromium.launch({
            headless: true,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-infobars',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        });
        const browserContext = await tokenBrowser.newContext({
            storageState: activeAccount.cookiesPath,
        });
        const page = await browserContext.newPage();
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        if (isLoginPage(currentUrl)) {
            await tokenBrowser.close();
            return { success: false, error: 'Sesi kadaluarsa. Login ulang akun ini di Manajemen Akun.' };
        }

        const fbDtsg = await page.evaluate(() => {
            if (window.DTSGInitData && window.DTSGInitData.token) return window.DTSGInitData.token;
            try { if (typeof require === 'function') { const m = require('DTSGInitData'); if (m && m.token) return m.token; } } catch { }
            const input = document.querySelector('input[name="fb_dtsg"]');
            if (input) return input.value;
            const html = document.documentElement.innerHTML;
            const m1 = html.match(/"DTSGInitData".*?"token":"([^"]+)"/);
            if (m1) return m1[1];
            const m2 = html.match(/fb_dtsg.*?value="([^"]+)"/);
            if (m2) return m2[1];
            return null;
        });

        await tokenBrowser.close();
        tokenBrowser = null;
        console.log(`[LOCATIONS] Token: ${fbDtsg ? fbDtsg.substring(0, 20) + '...' : 'NULL'}`);

        if (!fbDtsg) {
            return { success: false, error: 'Gagal membangun koneksi aman. Coba login ulang akun ini di Manajemen Akun.' };
        }

        // ── PHASE 2: API LOCATION REQUESTS ──
        console.log(`[LOCATIONS] Phase 2: Searching ${cities.length} cities...`);

        const requestContext = await (require('playwright')).request.newContext({
            storageState: activeAccount.cookiesPath,
            extraHTTPHeaders: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.facebook.com',
                'Referer': 'https://www.facebook.com/marketplace/',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
            },
        });

        // Helper: single location API request
        async function fetchLocationAPI(cityName) {
            try {
                const variables = {
                    params: {
                        caller: 'MARKETPLACE',
                        integration_strategy: 'STRING_MATCH',
                        page_category: ['CITY', 'SUBCITY', 'NEIGHBORHOOD', 'POSTAL_CODE'],
                        query: cityName,
                        search_type: 'PLACE_TYPEAHEAD',
                    },
                };

                const response = await requestContext.post('https://www.facebook.com/api/graphql/', {
                    form: {
                        fb_dtsg: fbDtsg,
                        doc_id: '9660140454040174',
                        variables: JSON.stringify(variables),
                    },
                    timeout: 15000,
                });

                if (response.status() !== 200) {
                    console.log(`[LOCATIONS] Status ${response.status()} for "${cityName}"`);
                    return [];
                }

                let text = await response.text();
                text = text.replace('for (;;);', '');
                const json = JSON.parse(text);

                // Parse edges
                const edges = json?.data?.city_street_search?.street_results?.edges || [];
                console.log(`[LOCATIONS] "${cityName}" → ${edges.length} results`);

                return edges.map((edge) => {
                    const node = edge?.node || {};
                    const name = node.name || '';
                    const subtitle = node.subtitle || '';
                    const singleLineAddress = node.single_line_address || '';

                    // Extract coordinates from the node
                    const latitude = node.latitude ?? node.location?.latitude ?? null;
                    const longitude = node.longitude ?? node.location?.longitude ?? null;

                    // Build fbName: prefer single_line_address, fallback to name + subtitle
                    let fbName = singleLineAddress || name;
                    if (!singleLineAddress && subtitle) {
                        fbName = name + ', ' + subtitle;
                    }

                    // Extract people visited count with robust regex
                    // Matches patterns like: "778 orang pernah singgah", "1.234 people visited", "5,678 orang"
                    let peopleVisited = 0;
                    const visitMatch = subtitle.match(/([\d.,]+)\s*(?:orang|people|visitor)/i);
                    if (visitMatch) {
                        peopleVisited = parseInt(visitMatch[1].replace(/[.,]/g, ''), 10) || 0;
                    }

                    return {
                        id: node.id || `loc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                        inputCity: cityName,
                        fbName: fbName,
                        province: province || '',
                        peopleVisited: peopleVisited,
                        latitude: latitude,
                        longitude: longitude,
                    };
                }).filter((item) => item.fbName.length > 0);
            } catch (e) {
                console.error(`[LOCATIONS] Error "${cityName}":`, e.message);
                return [];
            }
        }

        // Concurrency limiter
        async function batchWithConcurrency(tasks, limit) {
            const results = [];
            const executing = new Set();
            for (const task of tasks) {
                const p = task().then((r) => { executing.delete(p); return r; });
                executing.add(p);
                results.push(p);
                if (executing.size >= limit) await Promise.race(executing);
            }
            return Promise.all(results);
        }

        let completed = 0;
        const tasks = cities.map((city) => () => {
            completed++;
            sendProgress({
                currentId: 'location-scrape',
                currentIndex: completed,
                total: cities.length,
                status: 'SCRAPING',
                message: `Mencari lokasi "${city}" ... (${completed}/${cities.length})`,
            });
            return fetchLocationAPI(city);
        });

        const batchResults = await batchWithConcurrency(tasks, 3);
        const allLocations = batchResults.flat();

        await requestContext.dispose();

        sendProgress({
            currentId: 'location-scrape',
            currentIndex: cities.length,
            total: cities.length,
            status: 'COMPLETE',
            message: `Selesai! Ditemukan ${allLocations.length} lokasi dari ${cities.length} kota.`,
        });

        console.log(`[LOCATIONS] DONE: ${allLocations.length} locations from ${cities.length} cities`);
        return { success: true, locations: allLocations, total: allLocations.length };
    } catch (error) {
        if (tokenBrowser) {
            try { await tokenBrowser.close(); } catch { }
        }
        console.error('[LOCATIONS] Fatal error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// IPC: Marketplace – Auto Posting Engine (API Based)
// ============================================
let postingAborted = false;

ipcMain.handle('marketplace:stop-posting', async () => {
    postingAborted = true;
    console.log('[POSTING] Abort requested by user.');
    return { success: true };
});

ipcMain.handle('marketplace:start-posting', async (event, payload) => {
    const { accountIds, materialIds, delayMin = 30, delayMax = 60, concurrency = 1, modePosting = 'STANDAR', hideFromFriends = false } = payload;
    postingAborted = false;

    // ── Trial Enforcement: Post Limit ──
    const totalPosts = accountIds.length * materialIds.length;
    const trialCheck = await checkTrialLimit('posts', totalPosts);
    if (!trialCheck.allowed) {
        return { success: false, error: trialCheck.message, trial_limit: true };
    }

    const allAccounts = store.get('accounts', []);
    const allMaterials = store.get('posting_materials', []);

    // Resolve selected accounts & materials
    const selectedAccounts = allAccounts.filter((a) => accountIds.includes(a.id) && a.status === 'ACTIVE' && a.cookiesPath);
    const selectedMaterials = allMaterials.filter((m) => materialIds.includes(m.id));

    if (selectedAccounts.length === 0) {
        return { success: false, error: 'Tidak ada akun ACTIVE yang valid (perlu cookiesPath).' };
    }
    if (selectedMaterials.length === 0) {
        return { success: false, error: 'Tidak ada bahan posting yang dipilih.' };
    }

    const totalTasks = selectedAccounts.length * selectedMaterials.length;
    let globalDone = 0;
    let globalFailed = 0;

    const sendLog = (msg, type = 'info', meta = {}) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('posting:log', { msg, type, ...meta });
        }
    };
    const sendStatus = (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('posting:status', data);
        }
    };

    sendLog(`🚀 Misi dimulai! ${selectedAccounts.length} akun × ${selectedMaterials.length} bahan = ${totalTasks} tugas | Mode: ${modePosting}`, 'success');

    const { chromium } = require('playwright');

    // ── ACCOUNT WORKER: Process all materials for ONE account ──
    const processOneAccount = async (account, ai) => {
        if (postingAborted) return;

        sendLog(`👤 [${account.name || account.uid}] Membuka sesi...`);
        sendStatus({ accountId: account.id, status: 'Membuka Facebook...', step: 0 });

        let browser = null;
        let context = null;

        try {
            // Verify cookies file exists
            if (!fs.existsSync(account.cookiesPath)) {
                sendLog(`❌ [${account.name || account.uid}] File cookies tidak ditemukan. Skip.`, 'error');
                globalFailed += selectedMaterials.length;
                return;
            }

            // Launch headless browser with stored cookies
            browser = await chromium.launch({
                headless: true,
                ...SMART_BROWSER_CONFIG,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-infobars',
                    '--disable-features=IsolateOrigins,site-per-process',
                ],
            });
            context = await browser.newContext({
                storageState: account.cookiesPath,
                viewport: { width: 1280, height: 800 },
            });
            const page = await context.newPage();

            // Navigate to Facebook to activate cookies
            sendStatus({ accountId: account.id, status: 'Login dengan cookies...', step: 1 });
            try {
                await page.goto('https://www.facebook.com/', { waitUntil: 'commit', timeout: 45000 });
            } catch (navErr) {
                console.log(`[POSTING] Warning: Navigasi FB timeout (${navErr.message}), mencoba lanjut...`);
            }
            await page.waitForTimeout(4000); // Beri waktu FB render scripts

            // Check if cookies are valid
            const currentUrl = page.url().toLowerCase();
            if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
                sendLog(`❌ [${account.name || account.uid}] Cookies expired / checkpoint. Skip.`, 'error');
                globalFailed += selectedMaterials.length;
                await browser.close();
                return;
            }

            // Extract credentials with RETRY (FB sering lambat render token)
            sendStatus({ accountId: account.id, status: 'Mengekstrak token...', step: 2 });
            let fbDtsg = null;
            let uid = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                fbDtsg = await extractFbDtsg(page);
                uid = await extractUid(context);
                if (fbDtsg && uid) break;
                console.log(`[TOKEN] Attempt ${attempt}/3 gagal (dtsg=${!!fbDtsg}, uid=${!!uid}), retry in 3s...`);
                await page.waitForTimeout(3000);
            }

            if (!fbDtsg || !uid) {
                sendLog(`❌ [${account.name || account.uid}] Gagal ekstrak token/UID setelah 3x percobaan. Skip.`, 'error');
                globalFailed += selectedMaterials.length;
                await browser.close();
                return;
            }

            sendLog(`✅ [${account.name || account.uid}] Token & UID berhasil diambil. UID: ${uid}`);

            // ==========================================
            // GATEKEEPER: Daily Limit Detector
            // ==========================================
            sendStatus({ accountId: account.id, status: 'Mengecek batas posting...', step: 3 });
            try {
                await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'commit', timeout: 45000 });
            } catch (navErr) {
                console.log(`[GATEKEEPER] Warning: Navigasi gatekeeper timeout (${navErr.message}), mencoba lanjut...`);
            }
            await page.waitForTimeout(3000);

            const isLimited = await page.evaluate(() => {
                const text = document.body.innerText;
                return text.includes('Batas tercapai') || text.includes('Limit reached');
            });

            if (isLimited) {
                const limitMsg = 'Akun Limit, Jeda 1x24 Jam';
                sendLog(`🚫 [${account.name || account.uid}] ${limitMsg}. Melewati semua bahan.`, 'error');

                // Mark ALL materials as GAGAL and log to posting history
                for (let mi = 0; mi < selectedMaterials.length; mi++) {
                    const mat = selectedMaterials[mi];
                    globalFailed++;
                    sendStatus({
                        accountId: account.id,
                        materialId: mat.id,
                        status: 'LIMIT',
                        statusText: limitMsg,
                    });

                    // Save to posting history (electron-store)
                    const history = store.get('posting_history', []);
                    history.push({
                        id: generateId(),
                        accountId: account.id,
                        accountName: account.name || account.uid,
                        materialId: mat.id,
                        materialTitle: mat.judul || 'Unknown',
                        targetCity: mat.lokasi || '-',
                        status: 'GAGAL',
                        url: '',
                        errorMessage: limitMsg,
                        modePosting,
                        createdAt: new Date().toISOString(),
                    });
                    store.set('posting_history', history);
                }

                await browser.close();
                return;
            }

            sendLog(`✅ [${account.name || account.uid}] Tidak ada batas posting. Melanjutkan...`);

            // Process each material for this account (SEQUENTIAL within account)
            for (let mi = 0; mi < selectedMaterials.length; mi++) {
                if (postingAborted) {
                    sendLog('🛑 Misi dihentikan oleh user.', 'error');
                    break;
                }

                const material = selectedMaterials[mi];
                const taskLabel = `[${account.name || account.uid}] #${mi + 1}/${selectedMaterials.length}`;

                // ── NAVIGASI ULANG ke halaman Create (reset konteks setiap material) ──
                // Wajib agar pushState dari material sebelumnya tidak meracuni upload/API
                try {
                    await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'commit', timeout: 45000 });
                } catch (navErr) {
                    console.log(`[LOOP-RESET] Warning: Navigasi reset timeout (${navErr.message}), mencoba lanjut...`);
                }
                await page.waitForTimeout(3000);

                // DEBUG LOGGING — Data Pipeline Verification
                console.log(`[DEBUG BAHAN PIPA] Kategori: ${material.kategori}, Lat: ${material.latitude}, Lng: ${material.longitude}`);
                sendLog(`[DEBUG] Cek Data → Kategori: ${material.kategori || 'KOSONG'}, Lat: ${material.latitude || 'KOSONG'}, Lng: ${material.longitude || 'KOSONG'}`);

                sendLog(`📦 ${taskLabel} Memulai: ${material.judul}`, 'info', { accountId: account.id, materialId: material.id });
                sendStatus({
                    accountId: account.id,
                    materialId: material.id,
                    lokasi: material.lokasi || '',
                    status: 'UPLOADING',
                    statusText: 'Mengunggah Foto...',
                    step: 4,
                    currentMaterial: material.judul,
                    tasksDone: mi,
                    totalTasks: selectedMaterials.length,
                });

                // ── STEP 1: Upload Photos
                const photoPaths = extractPhotoPaths(material);
                let photoIDs = [];

                if (photoPaths.length > 0) {
                    sendLog(`📸 ${taskLabel} Mengunggah ${photoPaths.length} foto...`);

                    const uploadResult = await uploadMultiplePhotos({
                        page,
                        context,
                        filePaths: photoPaths,
                        onProgress: (idx, total, result) => {
                            if (result.success) {
                                sendLog(`  📷 Foto ${idx}/${total} uploaded: ${result.photoID}`);
                            } else {
                                sendLog(`  ⚠️ Foto ${idx}/${total} gagal: ${result.error}`, 'error');
                            }
                        },
                    });

                    photoIDs = uploadResult.photoIDs.filter(Boolean);

                    if (photoIDs.length === 0) {
                        sendLog(`❌ ${taskLabel} Semua foto gagal diupload. Skip posting ini.`, 'error', { accountId: account.id, materialId: material.id });
                        globalFailed++;
                        sendStatus({ accountId: account.id, materialId: material.id, status: 'ERROR', statusText: 'Foto gagal', step: 4, tasksDone: mi + 1, totalTasks: selectedMaterials.length });
                        // Log to posting history
                        const history = store.get('posting_history', []);
                        history.unshift({ id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7), accountId: account.id, accountName: account.name || account.uid, materialTitle: material.judul, targetCity: material.lokasi || '', status: 'GAGAL', url: '', errorMessage: 'Semua foto gagal diupload', modePosting, createdAt: new Date().toISOString() });
                        store.set('posting_history', history);
                        continue;
                    }

                    sendLog(`✅ ${taskLabel} ${photoIDs.length}/${photoPaths.length} foto berhasil diupload.`);
                } else {
                    sendLog(`⚠️ ${taskLabel} Tidak ada foto valid. Posting tanpa foto.`, 'warning');
                }

                // ── STEP 2: Publish Listing via GraphQL
                sendStatus({ accountId: account.id, materialId: material.id, status: 'PUBLISHING', statusText: 'Menerbitkan ke Server FB...', step: 5, currentMaterial: material.judul });

                let publishResult;

                if (modePosting === 'ANTI_DUPLIKAT') {
                    // ══════════════════════════════════════════
                    // KOMBO 3 LANGKAH: Draft → Auto-Save → Launch
                    // ══════════════════════════════════════════

                    // ── TAHAP 1: SIMPAN SEBAGAI DRAF BARU ──
                    sendLog(`🗒️ ${taskLabel} [ANTI-DUPLIKAT] Tahap 1: Menyimpan sebagai Draft...`, 'info', { accountId: account.id, materialId: material.id });

                    const draftResult = await publishListing({
                        page, context, fbDtsg, uid, material, photoIDs,
                        draftType: 'COMMERCE_SELL_OPTIONS',
                        hideFromFriends,
                    });

                    if (!draftResult.success) {
                        publishResult = { success: false, error: `Draft gagal: ${draftResult.error}` };
                    } else {
                        // Extract listing ID from URL
                        const draftUrl = draftResult.url || '';
                        const idMatch = draftUrl.match(/\/item\/(\d+)/) || draftUrl.match(/(\d{10,})/);
                        const listingId = idMatch ? idMatch[1] : null;

                        if (!listingId) {
                            sendLog(`⚠️ ${taskLabel} [ANTI-DUPLIKAT] Draft tersimpan tapi ID tidak ditemukan. URL: ${draftUrl}`, 'warning');
                            publishResult = draftResult;
                        } else {
                            sendLog(`✅ ${taskLabel} [ANTI-DUPLIKAT] Draft tersimpan (ID: ${listingId}).`, 'info');

                            // Extract permanent photo IDs from draft response
                            let realPhotoIds = null;
                            try {
                                if (draftResult.rawJson) {
                                    const resString = JSON.stringify(draftResult.rawJson);
                                    const match = resString.match(/"id":"(\d{15,})"/g);
                                    if (match) {
                                        const possibleIds = match.map(m => m.replace(/"id":"|"/g, ''))
                                            .filter(id => id !== listingId && id !== uid);
                                        if (possibleIds.length > 0) {
                                            realPhotoIds = [possibleIds[0]];
                                        }
                                    }
                                }
                            } catch (e) {
                                console.log('[ANTI-DUPLIKAT] Gagal parsing Asset ID dari response.');
                            }

                            if (realPhotoIds) {
                                sendLog(`📷 ${taskLabel} [ANTI-DUPLIKAT] Mendapat ID Foto Permanen: ${realPhotoIds[0]}`, 'info');
                            } else {
                                sendLog(`📷 ${taskLabel} [ANTI-DUPLIKAT] Menghapus photo_ids dari payload Edit.`, 'info');
                            }

                            // ── TAHAP 2: AUTO-SAVE / UPDATE DATA (Doc ID 249...) ──
                            sendLog(`⏳ ${taskLabel} [ANTI-DUPLIKAT] Jeda 5 detik...`, 'info');
                            await new Promise(r => setTimeout(r, 5000));

                            sendLog(`💾 ${taskLabel} [ANTI-DUPLIKAT] Tahap 2: Auto-Save / Update Data...`, 'info', { accountId: account.id, materialId: material.id });

                            const saveResult = await publishDraftListing({
                                page, context, fbDtsg, uid, material, photoIDs, listingId, realPhotoIds,
                                hideFromFriends,
                            });

                            if (!saveResult.success) {
                                sendLog(`⚠️ ${taskLabel} [ANTI-DUPLIKAT] Tahap 2 gagal: ${saveResult.error}`, 'warning');
                                publishResult = saveResult;
                            } else {
                                // ── TAHAP 3: THE FINAL LAUNCH (Doc ID 901...) ──
                                sendLog(`⏳ ${taskLabel} [ANTI-DUPLIKAT] Jeda 3 detik...`, 'info');
                                await new Promise(r => setTimeout(r, 3000));

                                sendLog(`🚀 ${taskLabel} [ANTI-DUPLIKAT] Tahap 3: Menerbitkan ke Publik!`, 'info', { accountId: account.id, materialId: material.id });

                                const launchResult = await launchDraftToPublic({
                                    page, fbDtsg, uid, listingId,
                                });

                                if (launchResult.success) {
                                    sendLog(`🎯 ${taskLabel} [ANTI-DUPLIKAT] BINGO! Postingan Aktif. ID: ${listingId}`, 'success');
                                    publishResult = launchResult;
                                } else {
                                    sendLog(`❌ ${taskLabel} [ANTI-DUPLIKAT] Tahap 3 gagal: ${launchResult.error}`, 'error');
                                    publishResult = launchResult;
                                }
                            }
                        }
                    }
                } else {
                    // ── STANDAR: Direct publish
                    sendLog(`🚀 ${taskLabel} Mengirim listing ke Facebook...`, 'info', { accountId: account.id, materialId: material.id });

                    publishResult = await publishListing({
                        page, context, fbDtsg, uid, material, photoIDs,
                        hideFromFriends,
                    });
                }

                if (publishResult.success) {
                    globalDone++;
                    sendLog(`✅ ${taskLabel} SUKSES! URL: ${publishResult.url}`, 'success', { accountId: account.id, materialId: material.id });
                    sendStatus({
                        accountId: account.id,
                        materialId: material.id,
                        status: 'SUCCESS',
                        statusText: 'Sukses! ✓',
                        step: 6,
                        currentMaterial: material.judul,
                        url: publishResult.url,
                        tasksDone: mi + 1,
                        totalTasks: selectedMaterials.length,
                    });
                    // Log SUCCESS to posting history
                    const historyS = store.get('posting_history', []);
                    historyS.unshift({ id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7), accountId: account.id, accountName: account.name || account.uid, materialId: material.id, materialTitle: material.judul, targetCity: material.lokasi || '', status: 'SUKSES', url: publishResult.url || '', errorMessage: '', modePosting, createdAt: new Date().toISOString() });
                    store.set('posting_history', historyS);
                } else {
                    globalFailed++;
                    sendLog(`❌ ${taskLabel} GAGAL: ${publishResult.error}`, 'error', { accountId: account.id, materialId: material.id });
                    sendStatus({
                        accountId: account.id,
                        materialId: material.id,
                        status: 'ERROR',
                        statusText: publishResult.error || 'Gagal',
                        step: 4,
                        tasksDone: mi + 1,
                        totalTasks: selectedMaterials.length,
                    });
                    // Log FAILURE to posting history
                    const historyF = store.get('posting_history', []);
                    historyF.unshift({ id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7), accountId: account.id, accountName: account.name || account.uid, materialId: material.id, materialTitle: material.judul, targetCity: material.lokasi || '', status: 'GAGAL', url: '', errorMessage: publishResult.error || 'Unknown error', modePosting, createdAt: new Date().toISOString() });
                    store.set('posting_history', historyF);
                }

                // Send global progress
                sendStatus({
                    type: 'global',
                    done: globalDone,
                    failed: globalFailed,
                    total: totalTasks,
                });

                // ── STEP 3: Random delay before next posting
                if (mi < selectedMaterials.length - 1) {
                    const delay = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin);
                    sendLog(`⏳ ${taskLabel} Jeda ${delay} detik...`);
                    sendStatus({ accountId: account.id, status: `Menunggu ${delay}s...`, step: 3 });

                    // Break delay into 1s chunks so abort can respond quickly
                    for (let d = 0; d < delay; d++) {
                        if (postingAborted) break;
                        await new Promise((r) => setTimeout(r, 1000));
                    }
                }

                // ── Cleanup: reset page to about:blank to free memory
                try { await page.goto('about:blank'); } catch (_) { }
            }

            // Close this account's browser
            await browser.close();
            browser = null;
            sendLog(`👤 [${account.name || account.uid}] Sesi ditutup.`);

        } catch (err) {
            sendLog(`❌ [${account.name || account.uid}] Error fatal: ${err.message}`, 'error');
            console.error('[POSTING] Account error:', err);
            if (browser) { try { await browser.close(); } catch { } }
        }
    };

    // ── THE EXECUTION POOL (Forced Parallel via Deferred Promises) ──
    sendLog(`🔀 Mode konkurensi: ${concurrency} akun berjalan bersamaan`, 'info');

    const runParallel = async (accounts, limit) => {
        const executing = new Set();

        for (const account of accounts) {
            if (postingAborted) {
                sendLog('🛑 Misi dihentikan oleh user.', 'error');
                break;
            }

            // Force deferred execution — this is the key to actual parallelism
            const p = Promise.resolve().then(() => processOneAccount(account, accounts.indexOf(account)));

            executing.add(p);
            p.finally(() => executing.delete(p));

            // Block ONLY when all concurrent slots are full
            if (executing.size >= limit) {
                await Promise.race(executing);
            }
        }

        // Wait for remaining workers in the last batch
        return Promise.all(executing);
    };

    await runParallel(selectedAccounts, concurrency);

    // Mission complete
    sendLog(`🏁 Misi selesai! ${globalDone} berhasil, ${globalFailed} gagal dari ${totalTasks} tugas.`, 'complete');
    sendStatus({ type: 'global', done: globalDone, failed: globalFailed, total: totalTasks, complete: true });

    return { success: true, done: globalDone, failed: globalFailed, total: totalTasks };
});


// ============================================
// IPC: Dashboard Stats (Aggregated)
// ============================================
ipcMain.handle('dashboard:get-stats', async () => {
    try {
        const accounts = store.get('accounts', []);
        const history = store.get('posting_history', []);

        const totalAkun = accounts.length;
        const akunAktif = accounts.filter(a => a.status === 'ACTIVE').length;

        let totalTawaranAktif = 0;
        let totalChatUnread = 0;
        accounts.forEach(acc => {
            if (acc.activeListings) {
                const n = parseInt(String(acc.activeListings).replace(/\D/g, ''));
                if (!isNaN(n)) totalTawaranAktif += n;
            }
            if (acc.unreadChats) {
                const n = parseInt(String(acc.unreadChats).replace(/\D/g, ''));
                if (!isNaN(n)) totalChatUnread += n;
            }
        });

        // Today's posting stats
        const todayStr = new Date().toISOString().split('T')[0];
        let totalHariIni = 0;
        let suksesHariIni = 0;
        history.forEach(h => {
            if (h.createdAt && h.createdAt.startsWith(todayStr)) {
                totalHariIni++;
                if (h.status === 'SUKSES') suksesHariIni++;
            }
        });

        return {
            success: true,
            data: { totalAkun, akunAktif, totalTawaranAktif, totalChatUnread, suksesHariIni, totalHariIni }
        };
    } catch (err) {
        console.error('[DASHBOARD] Gagal mengambil stats:', err);
        return { success: false, error: err.message };
    }
});

// ============================================
// IPC: Posting History (Persistence Logging)
// ============================================
ipcMain.handle('posting:get-history', async () => {
    try {
        return { success: true, history: store.get('posting_history', []) };
    } catch (err) {
        console.error('[HISTORY] Gagal mengambil riwayat:', err);
        return { success: false, history: [], error: err.message };
    }
});

ipcMain.handle('posting:clear-history', async () => {
    try {
        store.set('posting_history', []);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// Open URL with Account Session (Playwright)
// ============================================
ipcMain.handle('open-url-with-session', async (_event, { url, accountId }) => {
    try {
        const accounts = store.get('accounts', []);
        const account = accounts.find(a => a.id === accountId);
        if (!account || !account.cookiesPath || !fs.existsSync(account.cookiesPath)) {
            return { success: false, error: 'Cookies akun tidak ditemukan' };
        }

        const { chromium } = require('playwright');
        const browser = await chromium.launch({
            headless: false,
            ...SMART_BROWSER_CONFIG,
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--start-maximized',
            ],
        });
        const context = await browser.newContext({
            storageState: account.cookiesPath,
            viewport: null,
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'commit', timeout: 45000 });

        console.log(`[OPEN-URL] Opened ${url} with session ${account.name || accountId}`);
        return { success: true };
    } catch (err) {
        console.error('[OPEN-URL] Error:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('posting:delete-selected', async (_event, ids) => {
    try {
        const history = store.get('posting_history', []);
        const idSet = new Set(ids);
        store.set('posting_history', history.filter(h => !idSet.has(h.id)));
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ============================================
// License System
// ============================================
const LICENSE_API = 'https://script.google.com/macros/s/AKfycbzQckTt7YWeDTn-P8sE9Q4viQ7IjGfgqoIh5h3GYrkYOtpagc3O0WE48b_nDF0o8T7p/exec';

function getHWID() {
    const cpu = os.cpus()[0]?.model || 'unknown-cpu';
    const interfaces = os.networkInterfaces();
    const mac = Object.values(interfaces)
        .flat()
        .find(i => !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')?.mac || 'no-mac';
    const raw = cpu + '|' + mac + '|' + os.hostname();
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
}

// ── Trial Enforcement Helper ──
async function checkTrialLimit(type, count = 1) {
    const cached = store.get('license');
    if (!cached || cached.license_type !== 'trial') return { allowed: true };
    try {
        const result = await licenseApiCall('trial_usage.php', {
            action: 'increment',
            license_key: cached.license_key,
            hwid: getHWID(),
            type,
            count,
        });
        if (!result.success && result.error === 'LIMIT_REACHED') {
            return { allowed: false, message: result.message || `Batas trial ${type} tercapai. Upgrade ke premium.` };
        }
        return { allowed: result.success };
    } catch {
        return { allowed: true }; // Allow on network error (offline tolerance)
    }
}

async function queryTrialUsage() {
    const cached = store.get('license');
    if (!cached || cached.license_type !== 'trial') return null;
    try {
        return await licenseApiCall('trial_usage.php', {
            action: 'query',
            license_key: cached.license_key,
            hwid: getHWID(),
        });
    } catch { return null; }
}

// --- FUNGSI BARU MENGGUNAKAN AXIOS (Support Google Redirect) ---
const axios = require('axios'); // Pastikan ini ada

async function licenseApiCall(endpoint, body) {
    // Di Google Script, 'endpoint' (login.php dll) kita abaikan 
    // karena semua request masuk ke URL yang sama.
    // Kita kirim endpoint sebagai 'action' di dalam body jika belum ada.
    
    // Mapping endpoint PHP ke action sederhana
    if (endpoint.includes('login')) body.action = 'login';
    else if (endpoint.includes('check')) body.action = 'check';
    else if (endpoint.includes('trial')) body.action = 'trial';
    else if (endpoint.includes('reset')) body.action = 'reset';
    
    try {
        const response = await axios.post(LICENSE_API, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
            maxRedirects: 5 // Google Script suka redirect
        });
        return response.data;
    } catch (error) {
        console.error("License Error:", error.message);
        throw new Error('Gagal koneksi ke server database: ' + error.message);
    }
}


// --- License: Activate (login + activate) ---
ipcMain.handle('license:activate', async (_event, email, password) => {
    try {
        const hwid = getHWID();
        const result = await licenseApiCall('login.php', { email, password, hwid });

        if (result.success) {
            // Save to store (including trial info)
            store.set('license', {
                email: result.user.email,
                username: result.user.username,
                user_id: result.user.id,
                license_key: result.license.key,
                license_type: result.license.type || 'paid',
                product: result.license.product,
                product_slug: result.license.product_slug,
                icon: result.license.icon,
                expired_at: result.license.expired_at,
                days_left: result.license.days_left,
                hwid: result.license.hwid,
                hwid_locked_at: result.license.hwid_locked_at,
                last_reset: result.license.last_reset,
                trial_limits: result.license.trial_limits || null,
                last_check: Date.now(),
            });
        }
        return result;
    } catch (err) {
        return { success: false, error: 'Gagal koneksi ke server: ' + err.message };
    }
});

// --- License: Heartbeat check ---
ipcMain.handle('license:check', async () => {
    try {
        const cached = store.get('license');
        if (!cached || !cached.license_key) {
            return { success: false, error: 'No cached license', code: 'NO_CACHE' };
        }

        const hwid = getHWID();
        const result = await licenseApiCall('check.php', {
            license_key: cached.license_key,
            hwid: hwid,
        });

        if (result.valid) {
            // Update cache
            store.set('license.days_left', result.days_left);
            store.set('license.last_check', Date.now());
        }
        return result;
    } catch (err) {
        // Offline tolerance: if last check was < 24h ago, still valid
        const cached = store.get('license');
        if (cached && (Date.now() - cached.last_check) < 24 * 60 * 60 * 1000) {
            return { valid: true, days_left: cached.days_left, offline: true };
        }
        return { valid: false, error: 'Gagal koneksi: ' + err.message };
    }
});

// --- License: Reset HWID ---
ipcMain.handle('license:reset-hwid', async () => {
    try {
        const cached = store.get('license');
        if (!cached || !cached.license_key) {
            return { success: false, error: 'Tidak ada lisensi aktif' };
        }

        const result = await licenseApiCall('reset_hwid.php', {
            license_key: cached.license_key,
            email: cached.email,
        });

        if (result.success) {
            // Update HWID in cache
            const newHwid = getHWID();
            store.set('license.hwid', newHwid);
            store.set('license.last_reset', new Date().toISOString());
        }
        return result;
    } catch (err) {
        return { success: false, error: 'Gagal koneksi: ' + err.message };
    }
});

// --- License: Get cached data ---
ipcMain.handle('license:get-cache', async () => {
    return store.get('license', null);
});

// --- License: Clear (logout) ---
ipcMain.handle('license:clear-cache', async () => {
    store.delete('license');
    return { success: true };
});

// --- License: Get HWID ---
ipcMain.handle('license:get-hwid', async () => {
    return getHWID();
});

// --- Open URL in default browser ---
ipcMain.handle('license:open-url', async (_event, url) => {
    shell.openExternal(url);
    return { success: true };
});

// --- Trial: Query usage counters ---
ipcMain.handle('trial:query-usage', async () => {
    return await queryTrialUsage();
});

// ============================================
// App Lifecycle
// ============================================
app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
