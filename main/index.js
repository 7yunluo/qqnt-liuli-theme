// 琉璃主题插件 · 主进程侧
// 负责：日志、自己的 uid（给 @ 高亮区分 @我 / @别人）、诊断包导出（main/diag.js）。
// 功能性的东西（防撤回、复读、引用不带 @、记住位置）都在 qq-enhance 插件里。
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");

const SLUG = "liuli-dsh-theme";
const LOG = path.join(LiteLoader.path.data, SLUG, "plugin.log");

function log(message) {
    try {
        fs.mkdirSync(path.dirname(LOG), { recursive: true });
        fs.appendFileSync(LOG, new Date().toISOString() + " " + message + "\n");
    } catch (e) {}
}

log("main loaded | liteloader=" + LiteLoader.versions.liteloader + " qqnt=" + LiteLoader.versions.qqnt);

/* ---------- 诊断（每次启动写 session.log + 注册导出 IPC） ----------
 * 契约见 installer/DIAG-COVERAGE.md 第三 / 3.1 / 3.4 节。
 * 任何一步失败都只记 plugin.log，绝不影响插件原有功能。 */
let diag = null;
try {
    const diagModule = require("./diag.js");
    diag = diagModule.createDiag({ ipcMain: ipcMain, electron: require("electron") });
} catch (e) {
    log("diag create failed: " + (e && e.message));
}

try {
    if (diag) {
        const info = diag.install({ ipcMain: ipcMain });
        log("diag installed | ipc=" + info.ipcRegistered + " session=" + (info.sessionLog || "?"));
    }
} catch (e) {
    log("diag install failed: " + (e && e.message));
    diag = null;
}

/* ---------- 「删掉整个数据目录 = 彻底重置」标记 ----------
 * 用户能看到的只有数据目录 <LiteLoader.path.data>/liuli-dsh-theme/，
 * 但布局 / 明暗 / 壁纸 / 字体等其实存在渲染进程的 localStorage 里，删目录清不掉。
 * 所以用一个标记文件判断"用户是不是把整个数据目录删了"：
 *   wipe = 标记文件不存在 且 config.json 也不存在
 * 老用户正常升级到这个版本时 config.json 一定在 → wipe=false，绝不清他们的 localStorage；
 * 只有真的把整个目录删了（或全新安装）才 wipe。全新安装 localStorage 本来就是空的，清了也无害。
 * 判定完立刻把标记补上（空文件），下次启动 markerExists=true，不会重复触发。 */
const LIULI_DATA_DIR = path.join(LiteLoader.path.data, SLUG);
const LIULI_INIT_MARKER = path.join(LIULI_DATA_DIR, ".liuli-init");
const LIULI_CONFIG_FILE = path.join(LIULI_DATA_DIR, "config.json");

function liuliFileExists(p) {
    try { return fs.existsSync(p); } catch (e) { return false; }
}

let liuliWipePending = false;
try {
    const markerExists = liuliFileExists(LIULI_INIT_MARKER);
    const configExists = liuliFileExists(LIULI_CONFIG_FILE);
    liuliWipePending = !markerExists && !configExists;
    try { fs.mkdirSync(LIULI_DATA_DIR, { recursive: true }); } catch (e) {}
    if (!markerExists) fs.writeFileSync(LIULI_INIT_MARKER, "", "utf8");
    log("reset marker | marker=" + (markerExists ? 1 : 0) + " config=" + (configExists ? 1 : 0) +
        " wipe=" + (liuliWipePending ? 1 : 0));
} catch (e) {
    log("reset marker failed: " + (e && e.message));
}

/* 只读接口：渲染进程启动最早期问一次，wipe=true 就先清 localStorage 再继续启动。
 * wipe 只交给第一个来取的窗口（取完即消费），否则后开的窗口会把先开窗口
 * 刚写回的设置又清一遍。 */
ipcMain.handle("LiteLoader.liuli.resetPending", () => {
    const wipe = liuliWipePending === true;
    liuliWipePending = false;
    return { wipe: wipe };
});

/* LiteLoader 在内核报 onSessionInitComplete 时触发 onLogin(uid)。 */
let selfUid = "";
ipcMain.handle("LiteLoader.liuli.selfUid", () => selfUid);

/* 小程序卡片用默认浏览器打开：只放行 http/https */
ipcMain.handle("LiteLoader.liuli.openExternal", async (_e, url) => {
    try {
        const u = new URL(String(url));
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        await shell.openExternal(u.href);
        log("open external " + u.href);
        return true;
    } catch (e) {
        log("open external failed: " + e.message);
        try { if (diag) diag.sessionLog("error", "main", "openExternal 失败：" + e.message, { url: String(url) }); } catch (err) {}
        return false;
    }
});

/* ---------- 记住 QQ 设置窗口（含 LiteLoader 插件设置页）的大小和位置 ----------
 * QQ 的设置窗口是预创建的池化窗口：先 #/blank / about:blank，用到时才导航到 #/setting，
 * 所以不能只在 browser-window-created 时判断一次，要给每个窗口的 webContents 挂导航监听，
 * URL 变成 #/setting 时再接管（每个窗口只接管一次）。
 * 只碰 URL 命中 #/setting 的窗口，主窗口 / 聊天窗口 / 资料卡等完全不参与。
 * 任何一步失败都只记 plugin.log，绝不把异常抛到 QQ 主进程里。 */
const SETTINGS_FILE = path.join(LiteLoader.path.data, SLUG, "settings-window.json");
const SETTINGS_DEBOUNCE_MS = 400;
const SETTINGS_MIN_WIDTH = 600;
const SETTINGS_MIN_HEIGHT = 480;
const SETTINGS_MIN_OVERLAP = 100;   // 与屏幕 workArea 至少 100×100 交集才恢复

const settingsWindows = new WeakMap();   // BrowserWindow -> 记录

function isSettingsUrl(url) {
    const s = String(url || "");
    const i = s.indexOf("#");
    if (i < 0) return false;
    return s.slice(i + 1).startsWith("/setting");
}

/* screen 只在 app ready 后可用，延迟到调用时再取 */
function getElectronScreen() {
    try {
        const e = require("electron");
        return (e && e.screen) || null;
    } catch (e) {
        return null;
    }
}

function readSettingsBounds() {
    try {
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
        if (!data || typeof data !== "object") return null;
        const x = Number(data.x);
        const y = Number(data.y);
        const width = Number(data.width);
        const height = Number(data.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
        if (width <= 0 || height <= 0) return null;
        return { x: x, y: y, width: width, height: height, maximized: data.maximized === true };
    } catch (e) {
        if (e && e.code !== "ENOENT") log("settings window read failed: " + (e && e.message));
        return null;
    }
}

function writeSettingsBounds(bounds, maximized) {
    try {
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        const payload = {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
            maximized: !!maximized,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
    } catch (e) {
        log("settings window save failed: " + (e && e.message));
    }
}

/* 保存的矩形和任意一块屏幕的 workArea 有足够交集才恢复，避免窗口开到看不见的地方 */
function isBoundsOnScreen(bounds) {
    try {
        const screen = getElectronScreen();
        if (!screen || typeof screen.getAllDisplays !== "function") return false;
        const displays = screen.getAllDisplays() || [];
        for (let i = 0; i < displays.length; i++) {
            const area = displays[i] && displays[i].workArea;
            if (!area) continue;
            const overlapW = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
            const overlapH = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
            if (overlapW >= SETTINGS_MIN_OVERLAP && overlapH >= SETTINGS_MIN_OVERLAP) return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

function saveSettingsNow(rec) {
    if (!rec || rec.disposed) return;
    const win = rec.win;
    try {
        if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return;
        let minimized = false;
        try { minimized = typeof win.isMinimized === "function" && !!win.isMinimized(); } catch (e) { minimized = false; }
        if (minimized) return;   // 最小化时尺寸不可靠，保留上一次的存档
        let maximized = false;
        try { maximized = typeof win.isMaximized === "function" && !!win.isMaximized(); } catch (e) { maximized = false; }
        let bounds = null;
        try {
            bounds = typeof win.getNormalBounds === "function" ? win.getNormalBounds() : win.getBounds();
        } catch (e) {
            bounds = null;
        }
        if (!bounds) return;
        if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) return;
        writeSettingsBounds(bounds, maximized);
        log("settings window saved | " + Math.round(bounds.width) + "x" + Math.round(bounds.height) +
            " @ " + Math.round(bounds.x) + "," + Math.round(bounds.y) + (maximized ? " maximized" : ""));
    } catch (e) {
        log("settings window save failed: " + (e && e.message));
    }
}

function scheduleSettingsSave(rec) {
    if (!rec || rec.disposed) return;
    if (rec.timer) {
        try { clearTimeout(rec.timer); } catch (e) {}
        rec.timer = null;
    }
    rec.timer = setTimeout(function () {
        rec.timer = null;
        saveSettingsNow(rec);
    }, SETTINGS_DEBOUNCE_MS);
    /* 不让防抖定时器拖住 QQ 退出 */
    if (rec.timer && typeof rec.timer.unref === "function") rec.timer.unref();
}

function flushSettingsSave(rec) {
    if (!rec || rec.disposed) return;
    if (rec.timer) {
        try { clearTimeout(rec.timer); } catch (e) {}
        rec.timer = null;
    }
    saveSettingsNow(rec);
}

function disposeSettingsWindow(rec) {
    if (!rec || rec.disposed) return;
    rec.disposed = true;
    if (rec.timer) {
        try { clearTimeout(rec.timer); } catch (e) {}
        rec.timer = null;
    }
    try {
        if (rec.wc && rec.onUrl && typeof rec.wc.removeListener === "function") {
            rec.wc.removeListener("did-navigate", rec.onUrl);
            rec.wc.removeListener("did-navigate-in-page", rec.onUrl);
        }
    } catch (e) {}
    try { settingsWindows.delete(rec.win); } catch (e) {}
}

function onSettingsWindowReady(rec) {
    const win = rec.win;
    const saved = readSettingsBounds();
    if (saved && isBoundsOnScreen(saved)) {
        try {
            const x = Math.round(saved.x);
            const y = Math.round(saved.y);
            const width = Math.max(SETTINGS_MIN_WIDTH, Math.round(saved.width));
            const height = Math.max(SETTINGS_MIN_HEIGHT, Math.round(saved.height));
            win.setBounds({ x: x, y: y, width: width, height: height });
            if (saved.maximized && typeof win.maximize === "function") win.maximize();
            log("settings window restore | " + width + "x" + height + " @ " + x + "," + y + (saved.maximized ? " maximized" : ""));
        } catch (e) {
            log("settings window restore failed: " + (e && e.message));
        }
    } else {
        log("settings window open | " + (saved ? "saved bounds off screen" : "no saved bounds"));
    }

    /* 无论有没有存档都开始记录，这样第一次用完关掉就会留下存档 */
    try {
        if (typeof win.on === "function") {
            const schedule = function () { scheduleSettingsSave(rec); };
            win.on("resize", schedule);
            win.on("move", schedule);
            win.on("close", function () { flushSettingsSave(rec); });
        }
    } catch (e) {
        log("settings window save hook failed: " + (e && e.message));
    }
}

function trackSettingsWindow(win) {
    if (!win || typeof win !== "object" || settingsWindows.has(win)) return;

    const rec = { win: win, wc: null, owned: false, disposed: false, timer: null, onUrl: null };

    let wc = null;
    try { wc = win.webContents || null; } catch (e) { wc = null; }
    if (!wc || typeof wc.on !== "function") return;

    rec.wc = wc;
    settingsWindows.set(win, rec);

    const onUrl = function () {
        try {
            if (rec.disposed || rec.owned) return;
            let url = "";
            try { url = typeof wc.getURL === "function" ? wc.getURL() : ""; } catch (e) { url = ""; }
            if (!isSettingsUrl(url)) return;
            rec.owned = true;
            onSettingsWindowReady(rec);
        } catch (e) {
            log("settings window url hook failed: " + (e && e.message));
        }
    };
    rec.onUrl = onUrl;

    try { wc.on("did-navigate", onUrl); } catch (e) {}
    try { wc.on("did-navigate-in-page", onUrl); } catch (e) {}
    try { if (typeof win.once === "function") win.once("closed", function () { disposeSettingsWindow(rec); }); } catch (e) {}

    /* 挂监听之前就已经导航到 #/setting 的窗口（插件后加载）也要接管 */
    onUrl();
}

function installSettingsWindowMemory() {
    if (!app || typeof app.on !== "function") return;
    try {
        app.on("browser-window-created", function (_event, win) {
            try { trackSettingsWindow(win); } catch (e) { log("settings window hook failed: " + (e && e.message)); }
        });
    } catch (e) {
        log("settings window hook install failed: " + (e && e.message));
    }

    /* 插件可能晚于部分窗口创建，补挂一次已有窗口 */
    try {
        if (BrowserWindow && typeof BrowserWindow.getAllWindows === "function") {
            const wins = BrowserWindow.getAllWindows() || [];
            for (let i = 0; i < wins.length; i++) {
                try { trackSettingsWindow(wins[i]); } catch (e) {}
            }
        }
    } catch (e) {}
}

try {
    installSettingsWindowMemory();
} catch (e) {
    log("settings window memory init failed: " + (e && e.message));
}

module.exports = {
    onLogin(uid) {
        selfUid = String(uid || "");
        log("login uid=" + selfUid);
        try { if (diag) diag.sessionLog("info", "main", "登录完成", { uid: selfUid }); } catch (e) {}
    },
};
