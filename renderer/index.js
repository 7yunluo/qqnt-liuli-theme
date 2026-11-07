// 琉璃主题插件 · 渲染进程侧
// 1) 同步路由作用域（592 条规则依赖 data-hash）
// 2) 注入 CSS：壁纸 → QQ token 打透 → 静态色板兜底 → 外观
// 3) 从壁纸取源色，用 MCU 实时派生 M3 色板（跟随壁纸）
// 4) 顽固容器内联覆盖 + 对比度修复

const SLUG = "liuli-dsh-theme";
import { installLayout, applyBar, nativeBarItem, applyAll as llLayoutPass, buildLayoutSection } from "./layout-custom.js";
import { installArkExternal } from "./ark-external.js";
import { installTransparentImages } from "./transparent-image.js";
import { ROLE_KEY, loadRoles, roleVars, accentPalette, buildRoleControls } from "./color-roles.js";
// 诊断运行时（契约 installer/DIAG-COVERAGE.md 第三、3.2、3.3、3.5 节）：
// 尽早安装，后面整个模块体里任何 console.error / 未捕获异常 / Promise 拒绝
// 都会进环形缓冲并转发主进程 session.log。
import {
    installDiagRuntime, beginBoot, markBootReady, markBootFailed, auditWallpaper,
    collectDiagnostics, getErrors, getErrorCount, buildExportPayload, setImageRatioReader,
    noteThemeFailure, notePanelBuild
} from "./diag.js";
beginBoot();
installDiagRuntime();
const ASSET_BASE = "local://profile/plugins/" + SLUG + "/assets/";
const FILES = ["wallpaper.css", "qq-tokens.css", "palette.css", "liuli.css", "typography.css", "panel.css", "settings-page.css", "details.css", "no-dividers.css", "input-bar.css", "bubbles.css", "layout.css", "lists.css", "motion.css", "markdown.css", "layout-custom.css"];
const STYLE_ID = "liuli-dsh-theme";
const WALLPAPER = ASSET_BASE + "wallpaper.jpg";
// 默认壁纸不随插件发布：assets/wallpaper.css（内联壁纸）和 assets/wallpaper.jpg（取色用）
// 都是可选的本地文件。没有时没有默认壁纸，取色回退 DEFAULT_SOURCE，在设置页选图即可。
const OPTIONAL_FILES = new Set(["wallpaper.css"]);
const DEFAULT_SOURCE = "#1d9bf0";

/* ---------- 路由作用域 ---------- */
function installRouteScope() {
    if (window.__liuliRouteScope) return;
    window.__liuliRouteScope = true;
    const body = document.body;
    const sync = () => {
        const hash = location.hash || "";
        const path = location.pathname || "";
        if (body.dataset.hash !== hash) body.dataset.hash = hash;
        if (body.dataset.pathname !== path) body.dataset.pathname = path;
        // 值不变就不写：body 上的自定义属性一写，整页样式都要重算
        if (body.style.getPropertyValue("--hash") !== hash) body.style.setProperty("--hash", hash);
        if (body.style.getPropertyValue("--pathname") !== path) body.style.setProperty("--pathname", path);
        const scope = hash.indexOf("#/setting") === 0 ? "setting"
            : hash.indexOf("#/main") === 0 ? "main"
            : (hash === "" || hash === "#/blank") ? "boot" : "aux";
        if (body.dataset.liuliScope !== scope) body.dataset.liuliScope = scope;
    };
    sync();
    addEventListener("hashchange", sync);
    addEventListener("popstate", sync);
    setInterval(sync, 400);
}

/* ---------- 壁纸取色（照搬 dsh liuli-runtime.ts） ----------
 * 缩到 64×64，挑"最鲜艳且不太暗/太亮"的像素作为源色。
 * 原项目还会再和 MCU 的 sourceColorFromImage 比对色度，取更鲜艳的那个；
 * 这里简化为只用 chromatics，效果等价且不依赖额外 API。
 */
function chromaticSourceFromCanvas(ctx, w, h) {
    let px;
    try { px = ctx.getImageData(0, 0, w, h).data; } catch (e) { return null; }
    let best = { r: 29, g: 155, b: 240, score: -1 };
    for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
        if (a < 128) continue;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const chroma = max - min;
        const l = (max + min) / 2;
        if (l < 35 || l > 220) continue;
        const score = chroma - Math.abs(l - 128) * 0.4;
        if (score > best.score) best = { r, g, b, score };
    }
    const hex = v => v.toString(16).padStart(2, "0");
    return "#" + hex(best.r) + hex(best.g) + hex(best.b);
}

function chromaOf(hex) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return Math.max(r, g, b) - Math.min(r, g, b);
}

async function extractSource() {
    const img = new Image();
    // 用户选过壁纸就从那张取色；之前固定读插件自带的 wallpaper.jpg，
    // 换了壁纸主题色也不变（"没有自动取色"）。
    let src = WALLPAPER;
    try {
        const st = loadWallpaperState();
        if (st && st.src) src = st.src;
    } catch (e) {}
    img.src = src;
    if (img.decode) { await img.decode(); } else {
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    }
    /* #37：取色这一步本来就要把壁纸解码一遍，顺手把真实宽高比记进比例缓存。
     * 启动流程是「await applyDynamicPalette() → renderWallpaper(...,"boot")」，
     * 有了这一步，首帧渲染就能直接拿到比例，不会因为 ratioKnown:false 画成拉伸。 */
    try {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            llImageRatioCache.set(src, img.naturalWidth / img.naturalHeight);
        }
    } catch (e) { /* 静默 */ }
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return DEFAULT_SOURCE;
    ctx.drawImage(img, 0, 0, size, size);
    const picked = chromaticSourceFromCanvas(ctx, size, size);
    if (!picked) return DEFAULT_SOURCE;
    // 太灰就回退默认蓝（与 liuli-palette 的 chromaOf >= 24 判据一致）
    return chromaOf(picked) >= 24 ? picked : DEFAULT_SOURCE;
}

/* ---------- MCU 派生 M3 色板（照搬 liuli-palette.ts） ---------- */
const SURFACE_TONES = {
    light: { appBg: 98, low: 96, mid: 94, high: 92, highest: 90 },
    dark: { appBg: 6, low: 10, mid: 12, high: 17, highest: 22 }
};
const SCRIM = { low: 0.05, mid: 0.08, high: 0.11, highest: 0.14 };

function rgbTriplet(hex) {
    const h = hex.replace("#", "");
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(", ");
}

function alphaComposite(fg, bg, a) {
    const ph = fg.replace("#", ""), bh = bg.replace("#", "");
    const out = [0, 2, 4].map(i => {
        const p = parseInt(ph.slice(i, i + 2), 16);
        const b = parseInt(bh.slice(i, i + 2), 16);
        return Math.round(a * p + (1 - a) * b).toString(16).padStart(2, "0");
    });
    return "#" + out.join("");
}

function deriveVars(mcu, sourceHex, isDark, roles) {
    const theme = mcu.themeFromSourceColor(mcu.argbFromHex(sourceHex));
    const s = isDark ? theme.schemes.dark : theme.schemes.light;
    // 强调色可以换成次色 / 第三色（配色设置，#12）：同一条色调上取同样的 tone
    const acc = roles && (roles.accent === "secondary" || roles.accent === "tertiary") ? roles.accent : "primary";
    const tp = accentPalette(theme, roles);
    const neutral = theme.palettes.neutral;
    const nv = theme.palettes.neutralVariant;
    const st = SURFACE_TONES[isDark ? "dark" : "light"];
    const sc = t => mcu.hexFromArgb(neutral.tone(t));
    const primary = mcu.hexFromArgb(s[acc]);
    const onPrimary = mcu.hexFromArgb(s["on" + acc.charAt(0).toUpperCase() + acc.slice(1)]);
    const cLow = sc(st.low), cMid = sc(st.mid), cHigh = sc(st.high), cHighest = sc(st.highest);
    const glass2 = mcu.hexFromArgb(s.onSurfaceVariant);

    return {
        "--ll-brand": primary,
        "--ll-brand-rgb": rgbTriplet(primary),
        "--ll-brand-hover": mcu.hexFromArgb(tp.tone(isDark ? 76 : 44)),
        "--ll-brand-pressed": mcu.hexFromArgb(tp.tone(isDark ? 84 : 36)),
        "--ll-brand-tint": mcu.hexFromArgb(tp.tone(isDark ? 24 : 90)),
        "--ll-brand-weak": mcu.hexFromArgb(tp.tone(isDark ? 32 : 88)),
        "--ll-brand-line": mcu.hexFromArgb(tp.tone(isDark ? 48 : 60)),
        "--ll-on-brand": onPrimary,
        // 实底强调色上的描边要带 alpha（壁纸选框四角手柄），另给一个三元组，值同 onPrimary。
        "--ll-on-brand-rgb": rgbTriplet(onPrimary),
        "--ll-secondary": mcu.hexFromArgb(s.secondary),
        "--ll-tertiary": mcu.hexFromArgb(s.tertiary),
        "--ll-tertiary-container": mcu.hexFromArgb(s.tertiaryContainer),
        "--ll-on-tertiary-container": mcu.hexFromArgb(s.onTertiaryContainer),
        "--ll-secondary-container": mcu.hexFromArgb(s.secondaryContainer),
        "--ll-on-secondary-container": mcu.hexFromArgb(s.onSecondaryContainer),
        "--ll-on-glass": mcu.hexFromArgb(s.onSurface),
        "--ll-on-glass-rgb": rgbTriplet(mcu.hexFromArgb(s.onSurface)),
        // 文字角色以「没有壁纸」为基准：亮色底纯白、暗色底纯黑（liuli.css #app 底色）。
        // 在这个基准上 M3 的 onSurface / onSurfaceVariant / tone 40(66) 三级都远高于 4.5:1，层级也清楚；
        // 壁纸太暗 / 太亮时靠用户调不透明度和遮罩（滑条提示里有推荐区间），不再把文字压深来硬扛。
        "--ll-on-glass-2": glass2,
        "--ll-on-glass-2-rgb": rgbTriplet(glass2),
        "--ll-on-glass-3": mcu.hexFromArgb(nv.tone(isDark ? 66 : 40)),
        // 气泡里的发送者名字（markdown.css）= tertiary；玻璃上的链接 / @别人 = 强调色
        "--ll-name": mcu.hexFromArgb(s.tertiary),
        "--ll-link": primary,
        "--ll-on-glass-4": mcu.hexFromArgb(s.outlineVariant),
        "--ll-app-bg": sc(st.appBg),
        "--ll-surface-low": cLow,
        "--ll-surface-mid": cMid,
        "--ll-surface-high": cHigh,
        "--ll-surface-highest": cHighest,
        "--ll-surface-1": alphaComposite(primary, cLow, SCRIM.low),
        "--ll-surface-2": alphaComposite(primary, cMid, SCRIM.mid),
        "--ll-surface-3": alphaComposite(primary, cHigh, SCRIM.high),
        "--ll-surface-4": alphaComposite(primary, cHighest, SCRIM.highest),
        // 与 DSH liuli-runtime 一致：亚克力底取壁纸派生的 bg2/bg1/bg4（带品牌色相），
        // 之前这里没写，--ll-acrylic 停在静态蓝灰 30,37,48，和粉色品牌色对不上。
        "--ll-acrylic": rgbTriplet(alphaComposite(primary, cMid, SCRIM.mid)),
        "--ll-acrylic-low": rgbTriplet(alphaComposite(primary, cLow, SCRIM.low)),
        "--ll-acrylic-high": rgbTriplet(alphaComposite(primary, cHighest, SCRIM.highest)),
        "--ll-stroke-1": mcu.hexFromArgb(s.outline),
        "--ll-stroke-2": mcu.hexFromArgb(s.outlineVariant),
        // DSH border-l1 = stroke3：卡片发丝线。
        // 亮色原来是 tone 90（近白），叠在同样近白的玻璃上等于没有；改 tone 80 才看得见。
        // 暗色仍是 tone 40，视觉与改前完全一致。
        "--ll-stroke-3": mcu.hexFromArgb(nv.tone(isDark ? 40 : 80)),
        // DSH 侧栏选中项 = primaryContainer + onPrimaryContainer 指示条
        "--ll-primary-container": mcu.hexFromArgb(s.primaryContainer),
        "--ll-on-primary-container": mcu.hexFromArgb(s.onPrimaryContainer),
        "--ll-popup-bg": isDark ? sc(st.high) : sc(st.highest),
        // 壁纸遮罩的两种候选颜色（需求 A）：亮色主题默认盖白、暗色主题默认盖黑，
        // 具体用哪一种由设置里的 veilLight / veilDark 决定，最终写进 --ll-veil-rgb
        // （见 llApplyModeSettings）。这里只提供两者，不再按当前明暗写死。
        // 白色遮罩固定取中性色 tone 98（不论当前明暗都是同一档"纸白"）；
        // 弹窗遮罩 --ll-scrim-rgb 仍是黑（M3 scrim 语义）。
        "--ll-veil-white-rgb": rgbTriplet(sc(98)),
        "--ll-veil-black-rgb": "0, 0, 0",
        // 亮色下压在壁纸文字后面的浅色光晕（CSS 侧引用 --ll-halo-rgb）
        "--ll-halo-rgb": rgbTriplet(sc(98)),
        // 阴影基色：亮色用墨色（neutral tone 10），暗色保持纯黑（与改前一致）
        "--ll-shadow-rgb": isDark ? "0, 0, 0" : rgbTriplet(sc(10)),
        "--ll-danger": mcu.hexFromArgb(s.error),
        "--ll-danger-rgb": rgbTriplet(mcu.hexFromArgb(s.error)),
        "--ll-danger-bg": mcu.hexFromArgb(s.errorContainer),
        // M3 onError：压在 error 实底上的文字 / 图标（标题栏关闭按钮悬停、未读角标）。
        // 亮色的 error 是深红、暗色的 error 是浅红，写死白字在暗色下根本读不清。
        "--ll-on-danger": mcu.hexFromArgb(s.onError),
        // M3 inverseSurface / inverseOnSurface：轻提示（snackbar，QQ 的 .q-toast-item）用。
        // 和当前明暗反着来，暗色下是浅底深字、亮色下是深底浅字，压在什么界面上都看得清。
        "--ll-inverse-surface": mcu.hexFromArgb(s.inverseSurface),
        "--ll-inverse-on-surface": mcu.hexFromArgb(s.inverseOnSurface),
        "--ll-success": mcu.hexFromArgb(s.tertiary),
        // 警告色：亮色的 tertiaryContainer 是 tone 90 近白，当成警告图标 / 文字色根本看不见，
        // 亮色改用 tertiary（tone 40）；暗色保持 tertiaryContainer，视觉不变。
        "--ll-warn": mcu.hexFromArgb(isDark ? s.tertiaryContainer : s.tertiary)
    };
}

async function applyDynamicPalette() {
    if (window.__liuliPaletteApplied) return;
    window.__liuliPaletteApplied = true;
    let source = DEFAULT_SOURCE;
    try { source = await extractSource(); } catch (e) { source = DEFAULT_SOURCE; }
    const mcu = await import(ASSET_BASE + "mcu.js");
    const isDark = llIsDark();
    const roles = loadRoles();
    const vars = deriveVars(mcu, source, isDark, roles);
    // 选中项 / 气泡用哪个 M3 角色：见 color-roles.js（#7 #12）。
    // 旧版自己的气泡固定取「相反明暗」方案的 primaryContainer，现在默认同方案，「反相」保留旧样子。
    try {
        const theme = mcu.themeFromSourceColor(mcu.argbFromHex(source));
        Object.assign(vars, roleVars(mcu, theme, isDark, roles));
    } catch (e) {}
    const body = document.body;
    for (const k in vars) {
        if (vars[k] === null) body.style.removeProperty(k);
        else body.style.setProperty(k, vars[k]);
    }
    body.dataset.liuliSource = source;
    // 对方的气泡选了彩色（实底）配色：气泡尾巴可以压进气泡 1px 盖住缝（bubbles.css，#16）
    body.toggleAttribute("data-liuli-other-solid", vars["--ll-bubble-other"] != null);
    // 色板换了明暗，随模式变化的遮罩 / 阴影也要跟着重写（需求 A.2）
    llApplyModeSettings();
    console.log("[liuli-dsh-theme] wallpaper source = " + source + " (brand " + vars["--ll-brand"] + ")");
}

/* ---------- 承载层：只这些允许挂玻璃 ---------- */
const GLASS = [
    [".container-sidebar", "var(--ll-noise), rgba(var(--ll-acrylic), var(--ll-material-opacity))"],
    [".recent-contact", "var(--ll-noise), rgba(var(--ll-acrylic), var(--ll-material-opacity))"],
    // .chat-header 不加材质（群聊标题栏保持通透）
    // .chat-input-area 也不加！它的 backdrop-filter 是内联写入的，
    // 会让内部的 .msg-input（ProseMirror 编辑器）完全不绘制 ——
    // 表现就是"输入框消失、点了没反应"。输入区背景改由 input-bar.css 提供。
    [".right-sidebar", "var(--ll-noise), rgba(var(--ll-acrylic), var(--ll-material-opacity))"],
    [".group-box", "var(--ll-noise), rgba(var(--ll-acrylic), var(--ll-material-opacity))"],
    // 左下角资料卡；必须排除 .topbar-profile（顶部同名元素宽 1797px）
    [".user-profile-card:not(.topbar-profile)", "var(--ll-noise), rgba(var(--ll-acrylic), var(--ll-material-opacity))"]
];
const CLEAR = [
    ".message-panel", ".container-content-view", ".two-col-layout",
    ".two-col-layout__aside", ".two-col-layout__main", ".aio", ".group-chat",
    ".chat-msg-area",
    ".sidebar-nav", ".sidebar-wrapper",
    ".group-panel", ".group-box__container", ".group-box__wrapper",
    ".group-notice", ".group-member", ".group-user", ".group-member-list"
];

/* ---------- 颜色归一化 ----------
 * QQ 有大量规则直接写死颜色（不走 token），实测高频：
 *   rgba(255,255,255,0.9)  ×240   主文字
 *   rgba(255,255,255,0.4)  ×46
 *   rgba(255,255,255,0.7)  ×28   图标
 *   rgb(128,128,128)       ×若干  次要文字
 *   rgb(0,102,204)         tab 遮罩 / 发送按钮
 *   rgb(247,76,48)         红点
 * 这些只能靠内联改写。只改 color（不改背景），且只处理叶子节点，
 * 纯白 rgb(255,255,255) 不动 —— 那通常是品牌色实底上的正确反色。
 */
const QQ_COLOR_MAP = {
    "rgba(255, 255, 255, 0.9)": "var(--ll-on-glass)",
    "rgba(255, 255, 255, 0.8)": "var(--ll-on-glass)",
    "rgba(255, 255, 255, 0.7)": "var(--ll-on-glass-2)",
    "rgba(255, 255, 255, 0.6)": "var(--ll-on-glass-2)",
    "rgba(255, 255, 255, 0.5)": "var(--ll-on-glass-3)",
    "rgba(255, 255, 255, 0.4)": "var(--ll-on-glass-3)",
    "rgba(255, 255, 255, 0.3)": "var(--ll-on-glass-3)",
    "rgb(128, 128, 128)": "var(--ll-on-glass-2)",
    "rgb(102, 102, 102)": "var(--ll-on-glass-2)",
    "rgb(153, 153, 153)": "var(--ll-on-glass-2)",
    "rgb(204, 204, 204)": "var(--ll-on-glass-3)",
    "rgb(0, 102, 204)": "var(--ll-brand)",
    "rgb(45, 119, 229)": "var(--ll-brand)",
    "rgb(0, 153, 255)": "var(--ll-brand)",
    "rgb(247, 76, 48)": "var(--ll-danger)",
    "rgb(255, 51, 82)": "var(--ll-danger)",
    "rgb(21, 209, 115)": "var(--ll-success)",
    "rgb(255, 179, 0)": "var(--ll-warn)"
};

/* 性能护栏（2026-10-29）：发起群聊的选人对话框一次挂上几千个节点，
 * 原来每 1.5 秒对全页每个叶子节点 getComputedStyle，主线程被拖死。
 * 现在：每个节点只检查一次（WeakSet），每轮最多花 8ms，剩下的下一轮接着做。 */
const llColorSeen = new WeakSet();
function normalizeColors() {
    try {
        const t0 = performance.now();
        const nodes = document.querySelectorAll("body *");
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (llColorSeen.has(el)) continue;
            llColorSeen.add(el);
            if (el.dataset.liuliColor) continue;
            if (el.children.length > 0) continue;
            const text = (el.textContent || "").trim();
            if (!text) continue;
            const color = getComputedStyle(el).color.replace(/\s+/g, " ").trim();
            const mapped = QQ_COLOR_MAP[color];
            if (mapped) {
                el.dataset.liuliColor = "1";
                el.style.setProperty("color", mapped, "important");
            }
            if ((i & 63) === 0 && performance.now() - t0 > 8) return;
        }
    } catch (e) { /* 静默 */ }
}

const DIM_COLORS = new Set([
    "rgb(128, 128, 128)", "rgb(102, 102, 102)", "rgb(153, 153, 153)"
]);
const TEXT_SELECTORS = [
    ".text-ellipsis", ".secondary-info", ".group-user__name", ".group-member-name",
    ".group-member .user-name", ".recent-contact-item .text-ellipsis",
    ".contact-name", ".summary-main"
];

function fixContrast() {
    try {
        for (const sel of TEXT_SELECTORS) {
            document.querySelectorAll(sel).forEach(el => {
                if (el.dataset.liuliFg) return;
                const color = getComputedStyle(el).color.replace(/\s+/g, " ").trim();
                if (!DIM_COLORS.has(color)) return;
                el.dataset.liuliFg = "1";
                el.style.setProperty("color", "var(--ll-on-glass-2)", "important");
            });
        }
    } catch (e) { /* 静默 */ }
}

function applyOverrides() {
    try {
        for (const [sel, bg] of GLASS) {
            document.querySelectorAll(sel).forEach(el => {
                if (el.dataset.liuliGlass) return;
                el.dataset.liuliGlass = "1";
                el.style.setProperty("background", bg, "important");
                el.style.setProperty("backdrop-filter", "var(--ll-material-blur)", "important");
                el.style.setProperty("-webkit-backdrop-filter", "var(--ll-material-blur)", "important");
                el.style.setProperty("border-radius", "var(--ll-radius)", "important");
            });
        }
        for (const sel of CLEAR) {
            document.querySelectorAll(sel).forEach(el => {
                if (el.dataset.liuliClear) return;
                el.dataset.liuliClear = "1";
                el.style.setProperty("background", "transparent", "important");
                el.style.setProperty("backdrop-filter", "none", "important");
                el.style.setProperty("-webkit-backdrop-filter", "none", "important");
            });
        }
    } catch (e) { /* 静默 */ }
}

async function loadText(name) {
    const response = await fetch(ASSET_BASE + name);
    if (!response.ok) throw new Error(name + " HTTP " + response.status);
    return await response.text();
}

function ensureStyle() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(el);
    }
    return el;
}

const SETTINGS_KEY = SLUG;
const DEFAULT_SETTINGS = {
    blur: 18, opacity: 0.5, glow: 0.15, shadow: 0.6,
    // 壁纸遮罩（需求 A）：亮色 / 暗色主题各一份浓度，外加各自的遮罩颜色
    //   veilX = "light" → 盖一层白；veilX = "dark" → 盖一层黑
    dimLight: 0.18, dimDark: 0.18,
    veilLight: "light", veilDark: "dark",
    // 消息气泡：底色透明 / 背景模糊（模糊强度沿用 blur 那一项）
    bubbleClear: false, bubbleBlur: false
};
const DIM_MAX = 0.8;
const DIM_FALLBACK = 0.18;

/* 旧配置迁移（纯函数，不碰 DOM / localStorage，方便单独测）：
 * 早期只有一个 dim，读到就亮色 / 暗色两头都取它；顺手丢掉 dim 本身，
 * 并把 veilLight / veilDark 收窄到合法取值（缺省分别是 light / dark）。 */
function llMigrateSettings(raw) {
    const out = Object.assign({}, raw || {});
    const legacy = out.dim;
    if (legacy !== undefined && legacy !== null && legacy !== "") {
        // 新代码保存时一定会删掉 dim，所以还带着 dim 就说明是旧版写的，以它为准。
        // 不能只在 dimLight 缺失时才迁移：LiteLoader 的 config.get 会先把默认值
        // （dimLight / dimDark = 0.18）合并进旧配置，dimLight 永远「存在」。
        out.dimLight = legacy;
        out.dimDark = legacy;
    }
    delete out.dim;
    if (out.veilLight !== "light" && out.veilLight !== "dark") out.veilLight = "light";
    if (out.veilDark !== "light" && out.veilDark !== "dark") out.veilDark = "dark";
    return out;
}

/* 迁移 + 补默认值：读配置、收到别的窗口发来的配置，都走这里 */
function llNormalizeSettings(raw) {
    return Object.assign({}, DEFAULT_SETTINGS, llMigrateSettings(raw));
}

async function loadSettings() {
    try {
        const cfg = await LiteLoader.api.config.get(SETTINGS_KEY, DEFAULT_SETTINGS);
        return llNormalizeSettings(cfg);
    } catch (e) {
        return Object.assign({}, DEFAULT_SETTINGS);
    }
}

function saveSettings(cfg) {
    try {
        LiteLoader.api.config.set(SETTINGS_KEY, cfg);
    } catch (e) {}
}

/* ---------- 彻底重置：清 localStorage + 配置回默认 ----------
 * 两处用到：1) 启动时发现数据目录被整个删了（主进程 resetPending 返回 wipe=true）；
 *           2) 设置页「恢复全部默认」按钮。
 * 只删 liuli- / liuli_ 开头的键（前缀匹配，不走硬编码列表，新加的键也能清掉），
 * 再显式删一遍已知键兜底；绝不碰 QQ 自己的 localStorage。
 * 返回是否成功（清 localStorage 或写配置任一失败即 false）。 */
const LL_RESET_KNOWN_KEYS = [
    "liuli-layout", "liuli-layout-seen", "liuli-dsh-mode", "liuli-dsh-wallpaper",
    "liuli-dsh-wallpaper-rev", "liuli-dsh-main-viewport", "liuli-settings-tab",
    "liuli-md-render", "liuli-font", "liuli-dsh-settings", "liuli-color-roles",
    "liuli-wp-advice-dismissed"
];

async function llResetAll() {
    let ok = true;
    /* 1) localStorage：先按前缀扫一遍 */
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && /^liuli[-_]/i.test(k)) keys.push(k);
        }
        for (const k of keys) localStorage.removeItem(k);
    } catch (e) {
        ok = false;
        try { console.warn("[liuli-dsh-theme] reset localStorage failed:", e && e.message); } catch (err) {}
    }
    /* 2) 已知键再显式删一遍兜底。
     * 用字面量而不是后面的 LL_* 常量：启动最早期调用时那些 const 还没初始化，引用会撞 TDZ。 */
    for (const k of LL_RESET_KNOWN_KEYS) {
        try { localStorage.removeItem(k); } catch (e) {}
    }
    /* 3) config.json 回到默认值（set 可能是异步的，失败不影响前面已清掉的结果） */
    try {
        await LiteLoader.api.config.set(SETTINGS_KEY, Object.assign({}, DEFAULT_SETTINGS));
    } catch (e) {
        ok = false;
        try { console.warn("[liuli-dsh-theme] reset config failed:", e && e.message); } catch (err) {}
    }
    return ok;
}

/* 设置页窗口和主界面是两个独立 webContents，
 * 面板滑条改的只是设置页那一个窗口的 body 变量，主界面看不到。
 * 所以每次应用都把配置写进 localStorage，
 * 其它窗口靠 storage 事件收到后自行应用（同源，实时）。 */
const LL_STORAGE_KEY = "liuli-dsh-settings";
let llSuppressBroadcast = false;
/* 最近一次应用的配置（已归一化）。切换明暗时 llApplyModeSettings() 靠它取当前模式的遮罩 / 阴影。 */
let llModeCfg = Object.assign({}, DEFAULT_SETTINGS);

/* 某个模式该用哪一份遮罩浓度 / 遮罩颜色 */
function llDimFor(cfg, dark) {
    const v = dark ? cfg.dimDark : cfg.dimLight;
    const n = Number(v);
    return isFinite(n) && v !== null && v !== undefined ? n : DIM_FALLBACK;
}
function llVeilFor(cfg, dark) {
    return (dark ? cfg.veilDark : cfg.veilLight) === "light" ? "light" : "dark";
}
const LL_VEIL_RGB = {
    light: "var(--ll-veil-white-rgb, 255, 255, 255)",
    dark: "var(--ll-veil-black-rgb, 0, 0, 0)"
};

/* 按当前明暗应用「随模式变化」的那几项（需求 A.2 / B.4）：
 *   --ll-wallpaper-dim  → 当前模式的遮罩浓度
 *   --ll-veil-rgb       → 当前模式的遮罩颜色（亮 = 盖白 / 暗 = 盖黑）
 *   --ll-shadow(-float) → 阴影浓度；亮色乘 0.6，暗色乘 1（暗色结果与改前完全一致）
 * applySettings() 和 applyDynamicPalette() 都会调它，所以切换明暗时会自动重新应用。 */
function llApplyModeSettings() {
    const b = document.body;
    const cfg = llModeCfg || DEFAULT_SETTINGS;
    const dark = llIsDark();
    const shadow = Number(cfg.shadow);
    const s = isFinite(shadow) ? shadow : DEFAULT_SETTINGS.shadow;
    const k = dark ? 1 : 0.6;
    b.style.setProperty("--ll-wallpaper-dim", String(llDimFor(cfg, dark)));
    b.style.setProperty("--ll-veil-rgb", LL_VEIL_RGB[llVeilFor(cfg, dark)]);
    b.style.setProperty("--ll-shadow", "0 2px 10px rgba(var(--ll-shadow-rgb), " + (s * 0.4 * k).toFixed(2) + ")");
    b.style.setProperty("--ll-shadow-float", "0 8px 28px rgba(var(--ll-shadow-rgb), " + (s * 0.47 * k).toFixed(2) + ")");
}

function applySettings(cfg, broadcast) {
    const b = document.body;
    const prev = llModeCfg || DEFAULT_SETTINGS;
    const next = llNormalizeSettings(cfg);
    // 面板里的局部 settings 可能是加这两个开关之前建的快照，缺键就沿用当前值，别把开关打回关闭
    if (!(cfg && Object.prototype.hasOwnProperty.call(cfg, "bubbleClear"))) next.bubbleClear = prev.bubbleClear;
    if (!(cfg && Object.prototype.hasOwnProperty.call(cfg, "bubbleBlur"))) next.bubbleBlur = prev.bubbleBlur;
    llModeCfg = next;
    b.style.setProperty("--ll-material-blur", "blur(" + llModeCfg.blur + "px) saturate(1.6)");
    b.style.setProperty("--ll-material-opacity", String(llModeCfg.opacity));
    b.style.setProperty("--ll-glow-strength", String(llModeCfg.glow));
    b.style.setProperty("--liuli-shadow-strength", String(llModeCfg.shadow));
    b.dataset.liuliBubbleClear = llModeCfg.bubbleClear ? "1" : "0";
    b.dataset.liuliBubbleBlur = llModeCfg.bubbleBlur ? "1" : "0";
    llApplyModeSettings();

    if (broadcast !== false && !llSuppressBroadcast) {
        try { localStorage.setItem(LL_STORAGE_KEY, JSON.stringify(llModeCfg)); } catch (e) {}
    }
}

// 其它窗口的改动（含主界面自己收到设置页的改动）
try {
    window.addEventListener("storage", function (e) {
        if (e.key !== LL_STORAGE_KEY || !e.newValue) return;
        try {
            // 别的窗口可能还是旧版（只写 dim），进来先统一迁移一遍
            const incoming = llNormalizeSettings(JSON.parse(e.newValue));
            llSuppressBroadcast = true;
            applySettings(incoming, false);
            // 面板若存在，同步滑条位置
            const sliders = document.querySelectorAll(".liuli-slider");
            if (sliders.length === FIELDS.length) {
                FIELDS.forEach(function (f, i) {
                    const el = sliders[i];
                    if (el && Number(el.value) !== Number(incoming[f.key])) {
                        el.value = incoming[f.key];
                        el.dispatchEvent(new Event("input"));
                    }
                });
            }
            // 「遮罩颜色」分段按钮也跟着刷新（需求 A.4）
            llRefreshVeilSegs(incoming);
        } catch (err) {
        } finally {
            llSuppressBroadcast = false;
        }
    });
} catch (e) { /* 静默 */ }

/* 「遮罩颜色」分段按钮的刷新登记表：亮色 / 暗色各一个。
 * 别的窗口改了配置要跟着刷新；面板重建时清空，免得旧节点越积越多。 */
let llVeilSegRefreshers = [];
function llRefreshVeilSegs(cfg) {
    const c = cfg || llModeCfg;
    for (const fn of llVeilSegRefreshers) {
        try { fn(c); } catch (e) {}
    }
}

const FIELDS = [
    { key: "blur", label: "材质模糊", min: 0, max: 40, step: 1, unit: "px", hint: "玻璃层的 backdrop-filter 半径" },
    { key: "opacity", label: "不透明度", min: 0.1, max: 0.9, step: 0.01, unit: "", hint: "玻璃底有多实。过低会影响可读性", pct: v => ((v - 0.1) / 0.8) * 100 },
    { key: "glow", label: "泛光强度", min: 0, max: 1, step: 0.01, unit: "", hint: "品牌色在边缘的发光量", pct: v => v * 100 },
    { key: "shadow", label: "阴影强度", min: 0, max: 1, step: 0.01, unit: "", hint: "玻璃卡片的投影浓度", pct: v => v * 100 },
    // 壁纸遮罩拆成亮色 / 暗色两条（需求 A.1），各自下面挂一个「遮罩颜色」分段按钮
    { key: "dimLight", veilKey: "veilLight", label: "亮色主题遮罩", min: 0, max: DIM_MAX, step: 0.01, unit: "", hint: "亮色主题下盖在壁纸上的遮罩。过低会影响可读性", pct: v => (v / DIM_MAX) * 100 },
    { key: "dimDark", veilKey: "veilDark", label: "暗色主题遮罩", min: 0, max: DIM_MAX, step: 0.01, unit: "", hint: "暗色主题下盖在壁纸上的遮罩。过低会影响可读性", pct: v => (v / DIM_MAX) * 100 }
];

function toast(text) {
    let el = document.getElementById("liuli-toast");
    if (!el) {
        el = document.createElement("div");
        el.id = "liuli-toast";
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 1600);
}

/* ---------- 窗口控制按钮 ----------
 * QQ 给 .window-control-area 写了内联 !important：
 *   opacity: 0 !important; pointer-events: none !important; transform: translateY(-4px) !important
 * CSS 的 !important 打不过内联的 !important，只能由 JS 直接改内联属性。
 * 每次 QQ 重新写回 0 都要再纠正一次，所以挂在 1.5s 的定时器上。
 */
/* 窗口按钮现在由 layout.css 做「常态隐藏、指向唤出」，
 * 这里不能再内联 opacity:1 !important（内联 !important 会压过样式表，胶囊永远不隐藏）。
 * 只负责清掉旧版本留下的内联值。 */
function keepWindowControlsVisible() {
    try {
        const wc = document.querySelector(".window-control-area");
        if (!wc) return;
        ["opacity", "pointer-events", "transform"].forEach(function (k) {
            if (wc.style.getPropertyPriority(k) === "important") wc.style.removeProperty(k);
        });
    } catch (e) { /* 静默 */ }
}

/* ---------- 左侧设置导航：运行时求共同祖先，整条一块卡片 ----------
 * QQ 把设置导航拆成了多个容器（原生项一组、LiteLoaderQQNT 一组），
 * 用 class 选择器命中就会得到"上下两块卡片"。
 * 这里不猜类名：先找出所有导航行，再求它们的最低共同祖先，
 * 只给那一层加材质，并把中间层的材质清掉。
 */
const NAV_LABELS = ["通用", "消息通知", "存储管理", "快捷键", "权限设置", "登录设置",
    "账号绑定与授权", "超级调色盘", "关于QQ", "琉璃", "LiteLoaderQQNT"];

function applyNavCard() {
    if (!location.hash || location.hash.indexOf("#/setting") !== 0) return;
    try {
        // 1) 收集导航行
        const rows = [];
        const nodes = document.querySelectorAll("*");
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (el.children.length > 1) continue;
            const t = (el.textContent || "").trim();
            if (NAV_LABELS.indexOf(t) < 0) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 20 || r.height < 8 || r.x > 340) continue;
            let row = el;
            for (let d = 0; d < 5 && row; d++) {
                const rr = row.getBoundingClientRect();
                if (rr.width > 100 && rr.height >= 24 && rr.height <= 64) break;
                row = row.parentElement;
            }
            if (row && rows.indexOf(row) < 0) rows.push(row);
        }
        if (rows.length < 2) return;

        // 2) 求最低共同祖先
        const anc = [];
        let x = rows[0];
        while (x && x !== document.body && x !== document.documentElement) { anc.push(x); x = x.parentElement; }
        let common = null;
        for (const a of anc) {
            let all = true;
            for (const r of rows) { if (!a.contains(r)) { all = false; break; } }
            if (all) { common = a; break; }
        }
        if (!common) return;

        // 3) 只给共同祖先加材质（打标避免每轮重写）
        if (!common.dataset.liuliNavCard) {
            common.dataset.liuliNavCard = "1";
            common.style.setProperty("background", "rgba(var(--ll-acrylic), var(--ll-material-opacity))", "important");
            common.style.setProperty("backdrop-filter", "var(--ll-material-blur)", "important");
            common.style.setProperty("-webkit-backdrop-filter", "var(--ll-material-blur)", "important");
            common.style.setProperty("border-radius", "var(--ll-radius)", "important");
            common.style.setProperty("box-shadow", "var(--ll-shadow)", "important");
            common.style.setProperty("padding", "10px", "important");
            common.style.setProperty("margin", "44px 0 28px 24px", "important");
            common.style.setProperty("box-sizing", "border-box", "important");
            common.style.setProperty("overflow", "hidden auto", "important");
        }

        // 4) 清掉共同祖先与导航行之间的中间层材质（不然就是叠玻璃）
        for (const r of rows) {
            let n = r.parentElement;
            while (n && n !== common) {
                n.style.setProperty("background", "transparent", "important");
                n.style.setProperty("backdrop-filter", "none", "important");
                n.style.setProperty("-webkit-backdrop-filter", "none", "important");
                n.style.setProperty("box-shadow", "none", "important");
                n = n.parentElement;
            }
        }
    } catch (e) { /* 静默 */ }
}


/* ---------- 设置页：整层模糊（保守版） ----------
 * 教训：上一版把内部所有大块容器的 background 都清成 transparent，
 * 结果壁纸直接透上来，文字完全不可读（root 的 backdrop-filter 也没兜住）。
 *
 * 现在只做一件事：给设置页整层加一层半透明 + 模糊。
 * 内部容器一律不动 —— 保留 QQ 自己的深色卡片，保证文字可读。
 */
const SETTINGS_NAV_LABELS = ["通用", "消息通知", "存储管理", "快捷键", "权限设置",
    "登录设置", "账号绑定与授权", "超级调色盘", "关于QQ", "琉璃", "LiteLoaderQQNT"];

function settingsPageBlur() {
    if (!location.hash || location.hash.indexOf("#/setting") !== 0) return;
    try {
        let anchor = null;
        const nodes = document.querySelectorAll("*");
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (el.children.length > 1) continue;
            const t = (el.textContent || "").trim();
            if (SETTINGS_NAV_LABELS.indexOf(t) < 0) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 20 || r.x > 340) continue;
            anchor = el;
            break;
        }
        if (!anchor) return;

        let root = anchor;
        while (root.parentElement && root.parentElement !== document.body) {
            root = root.parentElement;
        }
        if (!root || root === document.body) return;

        if (!root.dataset.liuliSettingsBlur) {
            const r = root.getBoundingClientRect();
            // 只有在根容器确实覆盖了窗口主体时才动手，避免命中一个局部容器
            if (r.width < innerWidth * 0.6 || r.height < innerHeight * 0.6) return;
            root.dataset.liuliSettingsBlur = "1";
            root.style.setProperty("background", "rgba(var(--ll-acrylic), 0.5)", "important");
            root.style.setProperty("backdrop-filter", "blur(24px) saturate(1.6)", "important");
            root.style.setProperty("-webkit-backdrop-filter", "blur(24px) saturate(1.6)", "important");
        }
    } catch (e) { /* 静默 */ }
}


/* ---------- 输入区：TG 式单行 ----------
 * ⚠️ 关键教训：按钮千万不能挂进 .chat-input-area。
 * 那是 Vue 管理的子树，每次重渲染都会把外部节点清掉，
 * 于是按钮"时隐时现、点不到"。
 *
 * 现在做一层独立覆盖：#liuli-input-overlay 挂在 body 下，
 * position:fixed，每次 tick 只同步坐标，按钮本身建一次就不再动。
 */
const ICON_EMOJI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle>' +
    '<path d="M8 14s1.5 2 4 2 4-2 4-2"></path>' +
    '<line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line>' +
    '<line x1="5" y1="12" x2="19" y2="12"></line></svg>';

function buildInputOverlay() {
    var overlay = document.getElementById("liuli-input-overlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "liuli-input-overlay";
    overlay.style.cssText = [
        "position:fixed", "z-index:9999", "display:none", "align-items:center",
        "gap:4px", "pointer-events:none"
    ].join(";");

    // 输入框里的按钮（数量和顺序在设置页「输入框按钮」里调，见 layout-custom.js）
    var pins = document.createElement("div");
    pins.id = "liuli-bar-pins";
    pins.style.cssText = "display:flex;align-items:center;gap:4px";
    var emoji = pins;

    // 更多
    var more = document.createElement("button");
    more.id = "liuli-func-toggle";
    more.type = "button";
    more.title = "更多";
    more.setAttribute("aria-label", "更多");
    more.innerHTML = ICON_PLUS;
    more.addEventListener("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        // 悬停已经展开，点击只负责"保持展开"，不再 toggle（否则悬停后一点反而收起）
        setExpanded(true);
    });

    // 「更多」在左、「表情」在右（用户要求对调）
    overlay.appendChild(more);
    overlay.appendChild(pins);
    document.body.appendChild(overlay);

    // 指向展开：悬停 + 打开工具栏；离开按钮和工具栏 250ms 后收起。
    // 工具栏节点会被 Vue 重建，所以每次都重新查询，监听挂在 document 上。
    var hoverTimer = 0;
    function setExpanded(open) {
        var bar = document.querySelector(".chat-func-bar");
        if (!bar) return;
        // 按钮状态先同步：工具栏节点可能被 Vue 重建，下面提前 return 时按钮也不能停在 ×
        more.dataset.open = open ? "1" : "0";
        more.title = open ? "收起" : "更多";
        if (open) { llLabelFuncBar(bar); applyBar(); }
        if (bar.classList.contains("liuli-expanded") === open) return;
        bar.classList.toggle("liuli-expanded", open);
        var area = document.querySelector(".chat-input-area");
        if (area) {
            if (open) area.style.setProperty("z-index", "40", "important");
            else area.style.removeProperty("z-index");
        }
    }
    function isHoverZone(t) {
        if (!t || !t.closest) return false;
        return !!(t.closest("#liuli-func-toggle") || t.closest(".chat-func-bar.liuli-expanded"));
    }
    document.addEventListener("mouseover", function (e) {
        if (isHoverZone(e.target)) {
            clearTimeout(hoverTimer);
            if (e.target.closest("#liuli-func-toggle")) setExpanded(true);
        }
    }, true);
    document.addEventListener("mouseout", function (e) {
        if (!isHoverZone(e.target)) return;
        if (isHoverZone(e.relatedTarget)) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(function () { setExpanded(false); }, 250);
    }, true);

    // 点别处收起工具栏
    document.addEventListener("mousedown", function (e) {
        var bar = document.querySelector(".chat-func-bar");
        if (!bar || !bar.classList.contains("liuli-expanded")) return;
        if (bar.contains(e.target) || more.contains(e.target) || emoji.contains(e.target)) return;
        bar.classList.remove("liuli-expanded");
        more.dataset.open = "0";
        more.title = "更多";
        var area = document.querySelector(".chat-input-area");
        if (area) area.style.removeProperty("z-index");
    }, true);

    return overlay;
}

/* 工具栏改成竖排菜单后每行要显示文字：取 aria-label，去掉快捷键后缀
 * （"截图 Ctrl + Alt + A" → "截图"）。CSS 用 attr(data-liuli-label) 画出来。 */
function llLabelFuncBar(bar) {
    try {
        bar = bar || document.querySelector(".chat-func-bar");
        if (!bar) return;
        bar.querySelectorAll(".icon-item[aria-label]").forEach(function (it) {
            var t = (it.getAttribute("aria-label") || "").replace(/\s*(Ctrl|Alt|Shift|⌘)[\s\S]*$/, "").trim();
            if (it.dataset.liuliLabel !== t) it.dataset.liuliLabel = t;
        });
    } catch (e) { /* 静默 */ }
}

/* 每次 tick 只同步位置，不动按钮节点 */
function mountInputBar() {
    try {
        var overlay = buildInputOverlay();
        var area = document.querySelector(".chat-input-area");
        if (!area) {
            overlay.style.display = "none";
            return;
        }
        var r = area.getBoundingClientRect();
        if (r.width < 100 || r.height < 20 || r.bottom < 0 || r.top > window.innerHeight) {
            overlay.style.display = "none";
            return;
        }
        overlay.style.display = "flex";
        // 贴输入框左下角：多行时按钮留在底行（TG 行为），不漂到中间
        var box = area.querySelector(".msg-input");
        var br = box ? box.getBoundingClientRect() : r;
        overlay.style.left = Math.round(br.left + 6) + "px";
        // 与发送键同高（30px）、同底边距（7px），两边看起来一样大、一条水平线
        overlay.style.top = Math.round(br.bottom - 7 - 30) + "px";

        // 状态跟随实际，而不是相信本地记录：
        // 工具栏可能被"点别处收起"或 QQ 自己移除，local 的 data-open 会失真，
        // 表现就是按钮显示成 × 但工具栏其实没开。
        var bar = document.querySelector(".chat-func-bar");
        var expanded = !!(bar && bar.classList.contains("liuli-expanded"));
        var moreBtn = overlay.querySelector("#liuli-func-toggle");
        if (moreBtn && moreBtn.dataset.open !== (expanded ? "1" : "0")) {
            moreBtn.dataset.open = expanded ? "1" : "0";
            moreBtn.title = expanded ? "收起" : "更多";
        }
        var panel = document.querySelector(".expression-panel");
        var panelOpen = !!(panel && panel.getBoundingClientRect().height > 10);
        llSyncPins(overlay);
        var emojiBtn = overlay.querySelector("#liuli-emoji-btn");
        if (emojiBtn && emojiBtn.dataset.open !== (panelOpen ? "1" : "0")) {
            emojiBtn.dataset.open = panelOpen ? "1" : "0";
        }
    } catch (e) { /* 静默 */ }
}

/* 输入框里的按钮：按布局设置建代理按钮，点了转给 QQ 原生的工具栏按钮。
 * 名单没变就不重建（图标第一次没拿到时会补）。 */
function llSyncPins(overlay) {
    overlay = overlay || document.getElementById("liuli-input-overlay");
    var pins = overlay && overlay.querySelector("#liuli-bar-pins");
    if (!pins) return;
    var labels = applyBar();
    if (!labels.length && !document.querySelector(".chat-input-area .chat-func-bar")) return;
    // 只放当前会话里 QQ 真的有的按钮（#20）：「我的手机」这类会话 QQ 原生工具栏没有「表情」「图片」，
    // 以前照样摆出代理按钮，点了找不到原生按钮就什么都不做，看起来就是「按了没反应」。
    if (document.querySelector(".chat-input-area .chat-func-bar .bar-icon")) {
        labels = labels.filter(function (label) { return !!nativeBarItem(label); });
    }
    var key = labels.join("\u0001");
    var complete = !pins.querySelector("[data-noicon]");
    if (pins.dataset.key === key && complete) return;
    pins.dataset.key = key;
    pins.innerHTML = "";
    labels.forEach(function (label) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "liuli-bar-btn";
        if (label === "表情") b.id = "liuli-emoji-btn";
        b.title = label;
        b.setAttribute("aria-label", label);
        var native = nativeBarItem(label);
        var svg = native && native.querySelector("svg");
        if (label === "表情") b.innerHTML = ICON_EMOJI;
        else if (svg) b.innerHTML = svg.outerHTML;
        else { b.innerHTML = ICON_PLUS; b.dataset.noicon = "1"; }
        b.addEventListener("click", function (e) {
            e.stopPropagation();
            e.preventDefault();
            var n = nativeBarItem(label);
            if (n) n.click();
        });
        pins.appendChild(b);
    });
    // 输入框左边留出按钮的位置：每个按钮 28 + 间距 4，外加左右边距
    document.body.style.setProperty("--liuli-bar-pad", (12 + (labels.length + 1) * 34) + "px");
}


/* ---------- 气泡：把发送者名字/身份搬进气泡内部 ----------
 * TG 的样式（参考图）：
 *   ┌─────────────────────┐
 *   │ 群主 名字            │  ← 气泡内部顶部
 *   │ 消息内容             │
 *   │               18:57 │  ← 气泡内部右下
 *   └─────────────────────┘
 * QQ 的 .user-name 是气泡的兄弟节点，在气泡外面。
 * 这里在每次 tick 把它挪进 .msg-content-container，
 * 挪完打个标记，避免反复搬动。
 */
function moveSenderIntoBubble() {
    try {
        var containers = document.querySelectorAll(".message-container");
        for (var i = 0; i < containers.length; i++) {
            var mc = containers[i];
            var bubble = mc.querySelector(".msg-content-container");
            if (!bubble) continue;
            var name = mc.querySelector(".user-name");
            if (!name) continue;
            if (bubble.contains(name)) continue;
            // 把姓名节点搬到气泡最前面
            bubble.insertBefore(name, bubble.firstChild);
            bubble.dataset.liuliNamed = "1";
        }
    } catch (e) { /* 静默 */ }
}


/* ---------- 连续消息合并 ----------
 * TG 的规则：
 *   组内第一条 → 显示名字，隐藏头像
 *   组内中间   → 名字和头像都隐藏
 *   组内最后一条 → 隐藏名字，显示头像
 *   单条       → 名字 + 头像都显示
 * 发送者身份用「名字文本」判定（名字被搬进气泡后仍然可读），
 * 取不到名字时退回头像 src。
 */
function groupMessages() {
    try {
        var list = document.querySelectorAll(".message-container");
        if (list.length === 0) return;

        // ⚠️ 不能用整个 .user-name 的文本：指针悬停时 QQ 会往里插 .send-time 时间戳，
        // key 一变这条就被判成 single，名字/头像跳出来、和上下条分开。
        // 优先用头像的 aria-label（发送者昵称，悬停不变），再退到昵称本身的 span。
        function keyOf(mc) {
            var av = mc.querySelector(":scope > .avatar-span");
            var lbl = av && av.getAttribute("aria-label");
            if (lbl) return lbl;
            var nick = mc.querySelector(".user-name > .text-ellipsis");
            if (nick) {
                var t = (nick.textContent || "").trim();
                if (t) return t;
            }
            var img = mc.querySelector('[class*="avatar"] img');
            if (img && img.src) return img.src;
            return "";
        }

        var keys = [];
        for (var i = 0; i < list.length; i++) keys.push(keyOf(list[i]));

        for (var j = 0; j < list.length; j++) {
            var mc = list[j];
            var key = keys[j];
            if (!key) { mc.dataset.liuliG = ""; continue; }
            var prevSame = j > 0 && keys[j - 1] === key;
            var nextSame = j < list.length - 1 && keys[j + 1] === key;
            var g;
            if (!prevSame && !nextSame) g = "single";
            else if (!prevSame && nextSame) g = "first";
            else if (prevSame && nextSame) g = "mid";
            else g = "last";
            if (mc.dataset.liuliG !== g) mc.dataset.liuliG = g;
        }
    } catch (e) { /* 静默 */ }
}


/* ---------- 头像吸附（TG 行为） ----------
 * 头像只在组内最后一条上渲染，自然位置在组底。
 * 组底滚出视口下沿时，用 transform 把头像往上推到视口下沿，
 * 但不超过组内第一条气泡的顶 —— 头像始终贴着这一组消息。
 * 原位置用气泡计算（transform 不影响气泡的 rect）。
 */
/* 量第一个可见头像，把「头像高 + 1px」写进 --liuli-bubble-h，气泡最小高度靠它 */
function syncBubbleHeight() {
    try {
        var list = document.querySelectorAll(".message-container > .avatar-span");
        for (var i = 0; i < list.length && i < 8; i++) {
            var h = Math.round(list[i].getBoundingClientRect().height);
            if (h > 0) {
                if (document.documentElement.style.getPropertyValue("--liuli-bubble-h") !== (h + 1) + "px") {
                    document.documentElement.style.setProperty("--liuli-bubble-h", (h + 1) + "px");
                }
                return;
            }
        }
    } catch (e) { }
}

function stickAvatars() {
    try {
        var vp = document.querySelector(".chat-msg-area__vlist") || document.querySelector(".chat-msg-area");
        if (!vp) return;
        var vr = vp.getBoundingClientRect();
        var list = vp.querySelectorAll(".message-container");
        var groupTop = null;
        // 性能：先把要读的位置全部读完，再统一写 transform。
        // 以前边读边写，每写一次下一次读都要重新排版，滚动时一帧排版十几次。
        var writes = [];
        for (var i = 0; i < list.length; i++) {
            var mc = list[i];
            var g = mc.dataset.liuliG;
            // 用 wrapper 而不是 .msg-content-container：转发记录等卡片没有后者，
            // 而 wrapper 在普通消息里与气泡同框。
            var bubble = mc.querySelector(":scope > .message-content__wrapper") || mc.querySelector(".msg-content-container");
            if (!bubble) continue;
            var br = bubble.getBoundingClientRect();
            if (br.height < 1) continue;
            if (g === "first" || g === "single" || groupTop === null) groupTop = br.top;
            if (g !== "last" && g !== "single") continue;
            var av = mc.querySelector(":scope > .avatar-span");
            if (!av) continue;
            var h = av.offsetHeight || 32;
            var natBottom = br.bottom;
            var natTop = natBottom - h;
            var ty = 0;
            if (natBottom > vr.bottom - 4) ty = (vr.bottom - 4) - natBottom;
            var minTy = groupTop - natTop;
            if (ty < minTy) ty = minTy;
            if (ty > 0) ty = 0;
            writes.push([av, Math.round(ty)]);
            groupTop = null;
        }
        for (var w = 0; w < writes.length; w++) {
            var a = writes[w][0], t = String(writes[w][1]);
            if (a.dataset.liuliTy !== t) {
                a.dataset.liuliTy = t;
                a.style.transform = writes[w][1] ? "translateY(" + t + "px)" : "";
            }
        }
    } catch (e) { /* 静默 */ }
}

var liuliStickRaf = 0;
function scheduleStick() {
    if (liuliStickRaf) return;
    liuliStickRaf = requestAnimationFrame(function () {
        liuliStickRaf = 0;
        stickAvatars();
    });
}
function installAvatarStick() {
    if (window.__liuliStickInstalled) return;
    window.__liuliStickInstalled = true;
    // scroll 不冒泡，用捕获阶段监听；只管消息区的滚动，rAF 合并
    document.addEventListener("scroll", function (e) {
        var t = e.target;
        window.__llScrollT = performance.now();
        if (t && t.closest && !t.closest(".chat-msg-area")) return;
        scheduleStick();
    }, { capture: true, passive: true });
    window.addEventListener("resize", scheduleStick);
}


/* ---------- 消息区即时生效 ----------
 * 分组/名字搬进气泡/引用线原来只靠 1500ms 定时器，新消息（含虚拟列表滚动
 * 新挂上的行）会先以原生样式出现，最长 1.5 秒后才变。
 * MutationObserver 的回调在微任务里跑，早于下一帧绘制，所以首帧就是最终样式。
 * 自己造成的 DOM 变动用 takeRecords() 丢掉，避免回调自激。 */
/* ════════════════════════════════════════════════════════════
 * 侧栏列表：会话列表 / 群成员（2026-10-29）
 * ------------------------------------------------------------
 * 两个列表都是 QQ 的虚拟列表（Vue 管理），这里只做三类安全操作：
 *   1. 在 QQ 节点上写 data-liuli-* 标记，样式交给 lists.css；
 *   2. 用 Web Animations API 播动画（不改 style，Vue 无感）；
 *   3. 不插入、不移动任何节点。
 * ════════════════════════════════════════════════════════════ */
var LL_REDUCED = (function () { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } })();
var LL_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

function llNorm(s) { return (s || "").replace(/\s+/g, " ").trim(); }

/* 容器可视范围内的元素，按屏幕位置从上到下（排除虚拟列表的测量副本） */
function llVisibleIn(container, sel) {
    var cr = container.getBoundingClientRect();
    var out = [];
    container.querySelectorAll(sel).forEach(function (el) {
        if (el.closest(".viewport-list__measure")) return;
        var r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.bottom < cr.top || r.top > cr.bottom) return;
        out.push({ el: el, top: r.top });
    });
    out.sort(function (a, b) { return a.top - b.top; });
    return out.map(function (o) { return o.el; });
}

/* 逐行上浮入场（DSH 会话列表 liuli-treeitem-rise 同款） */
function llRiseIn(els, step) {
    if (LL_REDUCED || !els.length || typeof els[0].animate !== "function") return;
    els.slice(0, 18).forEach(function (el, i) {
        try {
            el.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }],
                { duration: 460, delay: i * (step || 26), easing: LL_EASE, fill: "backwards" });
        } catch (e) {}
    });
}

/* ── 会话列表：选中底色从旧位置滑到新位置 ──
 * 选中底色画在 .recent-contact-item--selected::before 上（lists.css），
 * 切换时对新选中项的 ::before 做 FLIP：从旧项的位置平移回来。
 * 用 data-contact-id 判断是否真的换了会话：虚拟列表滚动时会复用节点、
 * 重挂 --selected 类，id 不变就不动。 */
var llSel = { id: null, root: null, obs: null };
function llWatchContactList() {
    var root = document.querySelector(".recent-contact");
    if (!root || llSel.root === root) return;
    if (llSel.obs) llSel.obs.disconnect();
    llSel.root = root;
    var cur = llVisibleIn(root, ".recent-contact-item.recent-contact-item--selected")[0];
    llSel.id = cur ? cur.getAttribute("data-contact-id") : null;
    llSel.obs = new MutationObserver(function (recs) {
        var gained = null, lost = null;
        for (var i = 0; i < recs.length; i++) {
            var t = recs[i].target;
            if (!t.classList || !t.classList.contains("recent-contact-item")) continue;
            if (t.closest(".viewport-list__measure")) continue;
            var was = (recs[i].oldValue || "").indexOf("recent-contact-item--selected") >= 0;
            var now = t.classList.contains("recent-contact-item--selected");
            if (now && !was) gained = t;
            if (was && !now) lost = t;
        }
        if (!gained) return;
        var id = gained.getAttribute("data-contact-id");
        if (id === llSel.id) return;
        llSel.id = id;
        if (LL_REDUCED || typeof gained.animate !== "function") return;
        var nr = gained.getBoundingClientRect();
        var lr = lost && lost.isConnected ? lost.getBoundingClientRect() : null;
        try {
            if (lr && lr.height > 0) {
                var dy = Math.round(lr.top - nr.top);
                gained.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "translateY(0)" }], {
                    duration: Math.min(460, 240 + Math.abs(dy) * 0.22),
                    easing: "cubic-bezier(0.3, 1.25, 0.45, 1)",
                    pseudoElement: "::before"
                });
            } else {
                gained.animate([{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "none" }],
                    { duration: 260, easing: LL_EASE, pseudoElement: "::before" });
            }
        } catch (e) {}
    });
    llSel.obs.observe(root, { attributes: true, attributeFilter: ["class"], attributeOldValue: true, subtree: true });
    requestAnimationFrame(function () { llRiseIn(llVisibleIn(root, ".recent-contact-item"), 26); });
}

/* ── 群成员 ── */
/* 当前聊天里最近说话的人：名字 → 名次（0 = 最近一位，不含自己） */
function llRecentSpeakers() {
    var list = document.querySelectorAll(".chat-msg-area .message-container");
    var out = {}, rank = 0;
    for (var i = list.length - 1; i >= 0 && rank < 12 && i >= list.length - 60; i--) {
        var mc = list[i];
        if (mc.classList.contains("message-container--self") || mc.querySelector(".container--self")) continue;
        var av = mc.querySelector(":scope > .avatar-span");
        var n = llNorm(av && av.getAttribute("aria-label"));
        if (!n || Object.prototype.hasOwnProperty.call(out, n)) continue;
        out[n] = rank++;
    }
    return out;
}

/* #32.1b：当前群的稳定标识，给「管理人数」缓存当桶名。
 * 旧版直接取 `.chat-header .panel-header__title` 的整段文本，两个问题：
 *   1) 取不到时 llNorm() 返回 ""，所有群共用 llGM.staff[""] 同一个桶 → 人数串号；
 *   2) 标题里带着成员数「(260)」，有人进群 key 就变，缓存白丢。
 * 现在优先用会话列表选中项的 data-contact-id（切群才变）；
 * 但选中项可能比聊天标题晚一拍更新，名字对不上就不用，免得把人数写进别的群。
 * 退一级用标题里的群名（.chat-header__contact-name，不含成员数）。
 * 都取不到返回 ""——调用方据此跳过缓存（只按本次渲染结果展示）。 */
function llGroupKey() {
    var name = "";
    try {
        var h = document.querySelector(".chat-header .chat-header__contact-name");
        name = llNorm((h && (h.getAttribute("aria-label") || h.textContent)) || "")
            .replace(/\(\s*\d+\s*\)\s*$/, "");
    } catch (e) { /* 静默 */ }
    try {
        var items = document.querySelectorAll(".recent-contact-item--selected[data-contact-id]");
        for (var i = 0; i < items.length; i++) {
            var el = items[i];
            if (el.closest && el.closest(".viewport-list__measure")) continue;
            var id = el.getAttribute("data-contact-id");
            if (!id) continue;
            if (name && llNorm(el.textContent).indexOf(name) < 0) continue;   // 名字对不上：多半还没切过去
            return "c:" + id;
        }
    } catch (e) { /* 静默 */ }
    return name ? "n:" + name : "";
}

var llGM = { key: null, staff: {} };   // staff: key -> { n: 人数, exact: 是否确定完整 }
function llGroupMembersPass() {
    try {
        var gm = document.querySelector(".group-member");
        if (!gm) { llGM.key = null; return; }
        var rows = gm.querySelectorAll(".group-user");
        if (!rows.length) return;

        // 换群 → 成员行入场。
        // 标题先变，成员列表要等 QQ 拉完数据才换（2026-11-01 用户反馈：先给上一个群的成员播一遍入场动画，再突然刷新成新群）。
        // 所以换群时先记下当前（旧）成员的签名，等签名变了、也就是新成员真的到了，再播动画；
        // 1.5 秒内没变（两个群前几位成员恰好一样）就不播了，免得晚一拍突然动一下。
        // #32.1b：换群判据换成稳定 key（会话 id / 群名）。以前用整段标题文本，
        // 标题里带着成员数「(260)」——人数一变化就被误判成"换群"。
        var key = llGroupKey();
        var host = gm.querySelector(".group-member-list") || gm;
        var sig = function () {
            return Array.prototype.slice.call(host.querySelectorAll(".group-user__name"), 0, 6)
                .map(function (n) { return n.textContent; }).join("|");
        };
        if (key && key !== llGM.key) {
            // 只有这次启动后第一次看到群成员栏才直接播；之后（包括中间切去私聊再回来）都等新成员到了再播
            var first = !llGM.seen;
            llGM.seen = true;
            llGM.key = key;
            if (first) {
                requestAnimationFrame(function () { llRiseIn(llVisibleIn(host, ".group-user"), 16); });
            } else {
                llGM.pendingSig = sig();
                llGM.pendingAt = Date.now();
            }
        } else if (llGM.pendingSig != null) {
            var now = sig();
            if (now !== llGM.pendingSig) {
                llGM.pendingSig = null;
                requestAnimationFrame(function () { llRiseIn(llVisibleIn(host, ".group-user"), 16); });
            } else if (Date.now() - llGM.pendingAt > 1500) {
                llGM.pendingSig = null;
            }
        }

        // 管理团队：群主 + 管理员排在最前面且连续，画成一整块
        var byIdx = {};
        rows.forEach(function (r) {
            var i = Number(r.getAttribute("data-index"));
            if (!isNaN(i)) byIdx[i] = r;
        });
        var isStaff = function (r) { return !!(r && r.querySelector(".group-member-label")); };
        // #22：QQ 会把「Q群管家」这类机器人管理排在管理员中间，它没有管理员标签。
        // 以前遇到它就当作管理团队结束：下面的管理员既不算进人数，也被画成另一块卡片。
        // 现在夹在两个管理之间的非管理行（往后 3 行内还有管理）算进这一块，但不计人数。
        var inBlock = {};
        var blockEnd = -1;   // 管理团队之后第一个普通成员的 index；-1 表示还没渲染到
        var started = !!byIdx[0];   // 第 0 行在不在：在才谈得上"从头数管理块"
        var j = 0;
        if (started) {
            while (byIdx[j]) {
                if (isStaff(byIdx[j])) { inBlock[j] = true; j++; continue; }
                var more = false;
                for (var k = 1; k <= 3 && byIdx[j + k]; k++) if (isStaff(byIdx[j + k])) { more = true; break; }
                if (j > 0 && more) { inBlock[j] = true; j++; continue; }
                break;
            }
            if (byIdx[j]) blockEnd = j;
        }
        // 第 0 行没渲染（列表滚下去了）时没法确定整块范围，退回只看自己有没有管理员标签
        var staffAt = function (i) { return started ? !!inBlock[i] : isStaff(byIdx[i]); };
        Object.keys(byIdx).forEach(function (key2) {
            var i = Number(key2), r = byIdx[i];
            var g = "";
            if (staffAt(i)) {
                var prev = i > 0 && (byIdx[i - 1] ? staffAt(i - 1) : true);
                var next = byIdx[i + 1] ? staffAt(i + 1) : true;
                g = !prev && !next ? "single" : !prev ? "first" : !next ? "last" : "mid";
            }
            if ((r.dataset.liuliStaff || "") !== g) {
                if (g) r.dataset.liuliStaff = g; else delete r.dataset.liuliStaff;
            }
        });
        /* 管理人数（#32.1b）：只数带管理员标签的行。
         *  - blockEnd >= 0：管理块整块都渲染出来了 → 精确值，写缓存；
         *  - 只渲染到块中间（大群分批/虚拟渲染）：这只能算「至少 N」，显示成 "N+"，
         *    绝不写死成精确值——v1.3.2 对 #22 的修补就回归在这里：首屏只看到一个
         *    管理员就把 1 缓存下来，之后很难再被覆盖，于是「22 人只显示 1 人」；
         *  - 第 0 行都没渲染（列表滚下去了）→ 什么都别猜：有缓存用缓存，没有就空着。
         * key 为空（拿不到会话 id / 群名）时既不读也不写缓存，避免所有群共用
         * llGM.staff[""] 一个桶导致人数串号。 */
        var exact = blockEnd >= 0;
        var counted = 0;
        for (var m = 0; m < (exact ? blockEnd : j); m++) if (byIdx[m] && isStaff(byIdx[m])) counted++;
        var rec = key ? llGM.staff[key] : null;
        if (key && started) {
            if (exact) {
                rec = { n: counted, exact: true };
                llGM.staff[key] = rec;
            } else if (counted > 0 && (!rec || (!rec.exact && counted > rec.n))) {
                rec = { n: counted, exact: false };   // 只是"至少 N"，不能盖掉已知的精确值
                llGM.staff[key] = rec;
            }
        }
        var span = gm.querySelector(".group-member-title > span");
        var showN = 0, showExact = false;
        if (started && exact) { showN = counted; showExact = true; }
        else if (rec && rec.n > 0) { showN = rec.n; showExact = !!rec.exact; }
        else if (started && counted > 0) { showN = counted; showExact = false; }
        if (span) {
            var want = showN > 0 ? (showExact ? String(showN) : showN + "+") : "";
            if ((span.dataset.liuliStaff || "") !== want) {
                if (want) span.dataset.liuliStaff = want; else delete span.dataset.liuliStaff;
            }
        }

        // 最近发言：头像亮一圈，最近 3 位呼吸
        var recent = llRecentSpeakers();
        rows.forEach(function (r) {
            var nm = r.querySelector(".group-user__name");
            var name = llNorm(nm && nm.textContent);
            var rank = Object.prototype.hasOwnProperty.call(recent, name) ? recent[name] : -1;
            var v = rank < 0 ? "" : rank < 3 ? "hot" : "1";
            if ((r.dataset.liuliActive || "") !== v) {
                if (v) r.dataset.liuliActive = v; else delete r.dataset.liuliActive;
            }
        });
    } catch (e) { /* 静默 */ }
}

/* 两个列表的节点增删（滚动、换群、换会话）同步处理：
 * MutationObserver 回调在绘制前执行，新行第一帧就带着标记。 */
var llSideRaf = 0;
function installSideListObserver() {
    if (window.__liuliSideObs) return;
    var obs = new MutationObserver(function (recs) {
        var hit = false;
        for (var i = 0; i < recs.length && !hit; i++) {
            var t = recs[i].target;
            if (t && t.nodeType !== 1) t = t.parentElement;
            if (t && t.closest && t.closest(".group-member, .recent-contact, .two-col-layout__aside")) hit = true;
        }
        if (!hit || llSideRaf) return;
        // 合并到一帧：选人对话框等一次挂几千个节点时不会被触发成百上千次
        llSideRaf = requestAnimationFrame(function () {
            llSideRaf = 0;
            try { llWatchContactList(); llGroupMembersPass(); } catch (e) {}
        });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__liuliSideObs = obs;
}

function liuliMessagePass() {
    moveSenderIntoBubble();
    groupMessages();
    markQuoteRoots();
    scheduleStick();          // 读位置的活放到下一帧，不在 DOM 变动回调里强制排版
}


/* ---------- 动效：新消息出现 / 切换会话 ----------
 * 虚拟列表滚动时也会挂新节点，不能见节点就播动画。
 * 用 .ml-item 的消息 id（递增的 64 位整数）判断：只有比当前会话已见过的
 * 最大 id 还新的，才是"刚收到/刚发出"的消息。换会话时只记基线、不播。 */
var llMsgSeen = { chat: null, max: null };
function llChatKey() {
    var t = document.querySelector(".aio .chat-header .panel-header__title");
    return t ? (t.textContent || "").replace(/\s+/g, " ").trim() : "";
}
function llMsgId(el) {
    try { return el && /^\d+$/.test(el.id) ? BigInt(el.id) : null; } catch (e) { return null; }
}
function llMotionPass(added) {
    try {
        var key = llChatKey();
        var items = document.querySelectorAll(".chat-msg-area .ml-item[id]");
        if (!items.length) return;
        if (key !== llMsgSeen.chat) {
            var first = llMsgSeen.chat !== null;
            llMsgSeen.chat = key;
            var m = null;
            items.forEach(function (it) { var v = llMsgId(it); if (v !== null && (m === null || v > m)) m = v; });
            llMsgSeen.max = m;
            // 换会话：消息区整体轻轻浮上来
            if (first && !LL_REDUCED) {
                var area = document.querySelector(".chat-msg-area");
                if (area && area.animate) area.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
                    { duration: 280, easing: LL_EASE });
            }
            return;
        }
        if (LL_REDUCED || !added || !added.length) return;
        added.forEach(function (it) {
            var v = llMsgId(it);
            if (v === null || llMsgSeen.max === null || v <= llMsgSeen.max) return;
            llMsgSeen.max = v;
            var mc = it.querySelector(".message-container");
            var w = it.querySelector(".message-content__wrapper");
            if (!mc || !w || !w.animate) return;
            var self = mc.classList.contains("message-container--self") || !!mc.querySelector(".container--self");
            w.style.transformOrigin = self ? "100% 100%" : "0% 100%";
            w.animate([
                { opacity: 0, transform: "translateY(12px) scale(0.92)" },
                { opacity: 1, transform: "translateY(-2px) scale(1.01)", offset: 0.7 },
                { opacity: 1, transform: "none" }
            ], { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
            var av = mc.querySelector(":scope > .avatar-span");
            if (av && av.animate && getComputedStyle(av).display !== "none") {
                av.animate([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "none" }],
                    { duration: 300, delay: 60, easing: "cubic-bezier(0.3, 1.35, 0.45, 1)", fill: "backwards" });
            }
        });
    } catch (e) { /* 静默 */ }
}

/* 视觉管线（分组、气泡高度、头像贴合、引用线、Markdown、布局）。
 * 新消息进 DOM 就用 rAF 合并跑一次，不再等 1.5s 的定时器。 */
var llVisualQueued = false;
function liuliVisualPassNow() {
    try {
        if (window.__liuliPause) return;
        if (performance.now() - (window.__llScrollT || 0) < 250) return;
        if (document.querySelector(".q-dialog-modal")) { mountInputBar(); return; }
        applyOverrides(); fixContrast(); normalizeColors(); keepWindowControlsVisible(); mountInputBar();
        groupMessages(); syncBubbleHeight(); installTransparentImages(); stickAvatars(); markQuoteRoots();
        moveSenderIntoBubble(); ensureHoverEntries(); llWatchContactList(); llGroupMembersPass();
        llMarkdownPass(); llLayoutPass();
    } catch (e) { }
}
function liuliVisualPass() {
    if (llVisualQueued) return;
    llVisualQueued = true;
    requestAnimationFrame(function () { llVisualQueued = false; liuliVisualPassNow(); });
}

function installMessageObserver() {
    if (window.__liuliMsgObs) return;
    var busy = false;
    function touchesMessages(rec) {
        var t = rec.target;
        if (t && t.nodeType !== 1) t = t.parentElement;
        if (t && t.closest && t.closest(".chat-msg-area")) return true;
        for (var i = 0; i < rec.addedNodes.length; i++) {
            var n = rec.addedNodes[i];
            if (n.nodeType !== 1) continue;
            if (n.matches(".message-container, .chat-msg-area") || n.querySelector(".message-container")) return true;
        }
        return false;
    }
    var obs = new MutationObserver(function (recs) {
        if (busy || window.__liuliPause) return;
        var hit = false;
        for (var i = 0; i < recs.length; i++) { if (touchesMessages(recs[i])) { hit = true; break; } }
        if (!hit) return;
        busy = true;
        var added = [];
        for (var k = 0; k < recs.length; k++) {
            var an = recs[k].addedNodes;
            for (var q = 0; q < an.length; q++) {
                var nd = an[q];
                if (nd.nodeType !== 1) continue;
                if (nd.classList && nd.classList.contains("ml-item")) added.push(nd);
                else if (nd.querySelectorAll) nd.querySelectorAll(".ml-item[id]").forEach(function (x) { added.push(x); });
            }
        }
        try { liuliMessagePass(); } catch (e) { /* 静默 */ }
        try { llMotionPass(added); } catch (e) { /* 静默 */ }
        try { liuliVisualPass(); } catch (e) { /* 静默 */ }
        finally { obs.takeRecords(); busy = false; }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // 图片解码完成会改变气泡高度，立刻重排一次
    document.addEventListener("load", function (e) {
        if (e.target && e.target.tagName === "IMG") liuliVisualPass();
    }, true);
    window.__liuliMsgObs = obs;
}

/* 指向唤出的状态机：不用 :has(:hover)（这版 Chromium 里 :has + :hover 失效很慢，
 * 实测把手已 hover、侧栏仍不展开）。进入入口或控件本身 → body 打标记；
 * 离开两者 250ms 后清掉。控件节点会被 Vue 重建，所以用 closest 判断。 */
var LIULI_REVEAL = [
    ["show-l", "#liuli-top-hint-l, .topbar-profile"],
    ["show-r", "#liuli-top-hint-r, .window-control-area"],
    ["show-nav", "#liuli-nav-handle, .container-sidebar"]
];
function installRevealTracker() {
    if (window.__liuliReveal2) return;
    window.__liuliReveal2 = true;
    /* 按坐标判断，不依赖 mouseover/mouseout：
     * 那两个事件在 QQ 里会晚一拍到达，且离开时偶尔不来，标记就卡住不收。
     *   左边缘 ≤8px（整条）           → 展开导航；展开后指针在导航卡上就保持
     *   顶边 ≤ 胶囊底边（≈36px）左/右  → 唤出左上 / 右上胶囊；指针在胶囊上就保持
     * 离开后收起：导航 250ms；胶囊 600ms（#4 #10：给鼠标从感应条挪到按钮上留余量）。 */
    var EDGE = 8, PAD = 18, CORNER = 200;
    /* #32.4a：顶部唤出区不能只有窗口顶边 8px（--ll-dock-gap）。胶囊本体是
     * top:6px + height:30px（assets/layout.css:459-462），按钮 34×26 的点击面从
     * y≈8 才开始——只认 y≤8 时「光标已经在按钮上」反而唤不出来、点下去也没反应，
     * 用户必须再往下摸一次才行。这里把顶部感应带放宽到胶囊底边（≈36px）；
     * 左边缘（导航）仍只用 EDGE，不受影响。 */
    var TOP_EDGE = 36, topEdgeCache = 0;
    function topEdge() {
        if (topEdgeCache) return topEdgeCache;
        var v = TOP_EDGE;
        try {
            var el = document.querySelector(".topbar-profile") || document.querySelector(".window-control-area");
            if (el) {
                var t = parseFloat(getComputedStyle(el).top);
                var hh = el.offsetHeight || 0;
                if (isFinite(t) && hh > 0) v = Math.max(v, t + hh);      // top + height = 胶囊底边
            }
            var band = document.getElementById("liuli-top-hint-l");
            if (band) {
                var bh = band.getBoundingClientRect().height;
                if (bh > 0) v = Math.max(v, bh);                          // CSS 若把感应条加高，跟着它走
            }
        } catch (e) { /* 静默 */ }
        topEdgeCache = Math.max(EDGE, Math.min(64, v));   // 夹一层上限，CSS 改坏了也不至于整屏都算顶边
        return topEdgeCache;
    }
    var HOLD = { nav: 250, l: 600, r: 600 };
    var KEYS = { l: "liuliRL", r: "liuliRR", nav: "liuliRNav" };
    var state = {}, timers = {}, last = { x: -1, y: -1 };
    /* 需求 B：导航栏切成「固定」（body[data-liuli-nav-pin]）后常驻显示，
     * 不再跟鼠标展开 / 收起，也不释放焦点（releaseNavFocus 只在收起时调）。 */
    function navPinned() { return document.body.dataset.liuliNavPin === "1"; }
    function dropNav() {
        if (timers.nav) { clearTimeout(timers.nav); timers.nav = 0; }
        if (!state.nav && !document.body.dataset.liuliRNav) return;
        state.nav = false;
        delete document.body.dataset.liuliRNav;   // 固定时不该再有「展开」标记，否则 CSS 仍按展开态算
    }
    function set(k, on, hold) {
        if (k === "nav" && navPinned()) { dropNav(); return; }
        if (on) {
            if (timers[k]) { clearTimeout(timers[k]); timers[k] = 0; }
            if (!state[k]) { state[k] = true; document.body.dataset[KEYS[k]] = "1"; }
        } else if (state[k] && !timers[k]) {
            timers[k] = setTimeout(function () {
                timers[k] = 0; state[k] = false;
                delete document.body.dataset[KEYS[k]];
                if (k === "nav") releaseNavFocus();
            }, hold || HOLD[k]);
        }
    }
    /* #5：点了导航按钮后焦点留在按钮上，旧版 CSS 用 :focus-within 保持展开，
     * 鼠标移开导航也不收（而且没有展开态的材质）。现在 CSS 只认 :focus-visible，
     * 这里再把鼠标点出来的焦点还给页面，双保险。 */
    function releaseNavFocus() {
        try {
            var sb = document.querySelector(".container-sidebar");
            var a = document.activeElement;
            if (sb && a && a !== document.body && sb.contains(a) && !a.matches(":focus-visible")) a.blur();
        } catch (e) { /* 静默 */ }
    }
    function over(sel, x, y) {
        var el = document.querySelector(sel);
        if (!el) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && x >= r.left - PAD && x <= r.right + PAD && y >= r.top - PAD && y <= r.bottom + PAD;
    }
    function nativeBar() { return document.body.dataset.liuliTb === "native"; }
    function onMove(e) {
        var x = e.clientX, y = e.clientY, w = window.innerWidth;
        last.x = x; last.y = y;
        set("nav", x <= EDGE || (state.nav && over(".container-sidebar", x, y)));
        if (nativeBar()) { set("l", false); set("r", false); return; }
        // #32.4a：顶部按胶囊底边算（≈36px），不再只认窗口顶边 8px
        var top = topEdge();
        set("l", (y <= top && x >= 56 && x <= CORNER + 56) || (state.l && over(".topbar-profile", x, y)));
        set("r", (y <= top && x >= w - CORNER) || (state.r && over(".window-control-area", x, y)));
    }
    /* 鼠标进到拖动区 / 离开窗口时页面只收到一次 mouseleave，之后不再有 mousemove。
     * 如果离开前指针就在胶囊附近，多半只是经过了一小段拖动区，晚一点再收。 */
    function onLeave() {
        set("nav", false);
        ["l", "r"].forEach(function (k) {
            var sel = k === "l" ? ".topbar-profile" : ".window-control-area";
            set(k, false, state[k] && over(sel, last.x, last.y) ? 1500 : HOLD[k]);
        });
    }
    function onBlur() { set("nav", false); set("l", false); set("r", false); }
    document.addEventListener("mousemove", onMove, true);
    document.documentElement.addEventListener("mouseleave", onLeave);
    window.addEventListener("blur", onBlur);
}

/* ---------- 悬浮控件与侧栏的指向入口 ----------
 * ⚠️ QQ 顶部 40px 与左侧 52px 是窗口拖动区（-webkit-app-region: drag），
 * Windows 下鼠标在拖动区里不会把事件发给页面，:hover 永远不触发。
 * 所以入口必须是单独的 no-drag 元素，挂在 body 下（Vue 不会清掉）。
 *   #liuli-top-hint-l / -r：窗口顶边（#32.4a 后放宽到胶囊底边 ≈36px）的感应条，
 *                          指向时唤出左上/右上胶囊
 *   #liuli-nav-handle    ：左边缘的小把手，指向时滑出导航栏 */
function ensureHoverEntries() {
    try {
        installRevealTracker();
        [["liuli-top-hint-l", "唤出个人信息"], ["liuli-top-hint-r", "唤出窗口按钮"]].forEach(function (pair) {
            var el = document.getElementById(pair[0]);
            if (!el) {
                el = document.createElement("div");
                el.id = pair[0];
                el.className = "liuli-top-hint";
                el.title = pair[1];
                document.body.appendChild(el);
            }
            /* #32.4a：感应条要覆盖胶囊高度（≈36px），所以它必须待在胶囊下面，
             * 否则会挡住胶囊上按钮的真实点击面。胶囊是 z-index 3600，这里内联兜底
             * 到 3500——CSS 那边不管怎么调高度都不会把按钮点没了。 */
            if (el.style.zIndex !== "3500") el.style.zIndex = "3500";
        });
        if (!document.getElementById("liuli-nav-handle")) {
            var h = document.createElement("div");
            h.id = "liuli-nav-handle";
            h.title = "展开导航";
            h.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
                'stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg>';
            document.body.appendChild(h);
        }
    } catch (e) { /* 静默 */ }
}


/* ---------- 引用块：只保留最外层那一条竖线 ----------
 * QQ 的引用结构是嵌套的（reply 里还有 reply），
 * 所以 [class*="reply"] 会给每一层都加一条 border-left，
 * 视觉上就是引用块左边好几条竖线。
 * 这里给最外层打 data-liuli-quote-root="1"，内层打 "0"，
 * CSS 只对 1 画线，0 全部清空。
 */
function markQuoteRoots() {
    try {
        // 全部先归零（只看消息区、只看还没标过的：以前每次 DOM 变动都扫全页的 [class*=…]，滚动时很重）
        var all = document.querySelectorAll('.chat-msg-area :is([class*="reply"], [class*="quote"]):not([data-liuli-quote-root])');
        for (var i = 0; i < all.length; i++) {
            if (all[i].dataset.liuliQuoteRoot !== "0") all[i].dataset.liuliQuoteRoot = "0";
        }
        // 只有 .reply-element 才是真正的引用块根。
        // ⚠️ 不要用"父级链里有没有 reply"判断：
        //   气泡根本身就叫 reply-message__container，
        //   那样会把每一层都判成嵌套，结果一条线都不画。
        var roots = document.querySelectorAll(".reply-element");
        // 虚拟列表会复用节点：以前是根、现在不是的，改回 0
        var stale = document.querySelectorAll('[data-liuli-quote-root="1"]:not(.reply-element)');
        for (var s = 0; s < stale.length; s++) stale[s].dataset.liuliQuoteRoot = "0";
        for (var j = 0; j < roots.length; j++) {
            if (roots[j].dataset.liuliQuoteRoot !== "1") roots[j].dataset.liuliQuoteRoot = "1";
        }
    } catch (e) { /* 静默 */ }
}

/* 把面板的控件构建到任意容器里（内嵌与浮层共用同一套逻辑） */

/* ---------- 壁纸（参考 dsh liuli-runtime 的做法） ----------
 * dsh 用 localStorage 存壁纸 dataURL；这里同样：
 *   - 用户选图 → FileReader → dataURL → localStorage
 *   - 用一条独立 <style> 覆盖 #app::before 的 background-image
 *   - 遮罩浓度走 --ll-wallpaper-dim、遮罩颜色走 --ll-veil-rgb，
 *     两个值都由 llApplyModeSettings() 按当前明暗写入（亮色 / 暗色各一份设置）
 */
const LL_WALLPAPER_KEY = "liuli-dsh-wallpaper";
// 跨窗口同步兜底（契约第四节第 3 条）：每次保存壁纸写一个毫秒字符串的小键，
// 主窗口只读它判断"是否变了"，避免每 1.5 秒解析 783KB 的壁纸 dataURL。
const LL_WALLPAPER_REV_KEY = "liuli-dsh-wallpaper-rev";

function llErrText(e) {
    if (!e) return "";
    try {
        const name = e.name ? String(e.name) : "";
        const msg = e.message != null ? String(e.message) : String(e);
        // 普通 Error 不显示 "Error: " 前缀；QuotaExceededError 之类保留异常名
        return name && name !== "Error" && msg.indexOf(name) !== 0 ? name + ": " + msg : msg;
    } catch (err) {
        return "[unprintable error]";
    }
}

function llScopeName() {
    try {
        return (document.body && document.body.dataset && document.body.dataset.liuliScope) || "unknown";
    } catch (e) {
        return "unknown";
    }
}

function llWallpaperRev() {
    try { return localStorage.getItem(LL_WALLPAPER_REV_KEY) || ""; } catch (e) { return ""; }
}

function llFmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + "MB";
    if (v >= 1024) return (v / 1024).toFixed(1) + "KB";
    return v + "B";
}

/* ════════════════════════════════════════════════════════════
 * 壁纸：选区模型 + 框选编辑（照搬 dsh liuli-theme）
 * ------------------------------------------------------------
 * dsh 的做法不是"缩放 + 位置"滑条，而是归一化选区 {x,y,w,h}：
 *   - 预览按窗口比例渲染，所见即所得
 *   - 框选时显示完整图片，鼠标拖拽创建/移动/拖角缩放
 *   - 选区恒定保持窗口宽高比，所以画面永不拉伸
 *   - 写进 CSS 时用 bgGeometry 推导 background-size / position
 * ════════════════════════════════════════════════════════════ */

const LL_WP_DEFAULTS = { src: null, area: null, fit: "cover" };

function loadWallpaperState() {
    try {
        const raw = localStorage.getItem(LL_WALLPAPER_KEY);
        if (!raw) return Object.assign({}, LL_WP_DEFAULTS);
        const parsed = raw.charAt(0) === "{" ? JSON.parse(raw) : { src: raw };
        const st = Object.assign({}, LL_WP_DEFAULTS, parsed);
        // 兼容早期滑条版存下的字段（scale/posX/posY）——直接丢掉，回落到 cover
        if (!st.area || typeof st.area.w !== "number") st.area = null;
        return st;
    } catch (e) {
        return Object.assign({}, LL_WP_DEFAULTS);
    }
}

/* 保存壁纸：不再吞异常（契约第四节第 1 条）。
 * 返回 { ok, error }，失败时由调用方 toast + 审计；同时写 revision 小键供主窗口轮询。 */
function saveWallpaperState(state, broadcast) {
    let ok = false;
    let error = "";
    let valueLen = 0;
    let revOk = false;
    let revError = "";
    try {
        const raw = JSON.stringify(state);
        valueLen = raw.length;
        localStorage.setItem(LL_WALLPAPER_KEY, raw);
        ok = true;
    } catch (e) {
        error = llErrText(e);
    }
    if (ok) {
        try {
            localStorage.setItem(LL_WALLPAPER_REV_KEY, String(Date.now()));
            revOk = true;
        } catch (e) {
            revError = llErrText(e);
        }
    }
    auditWallpaper("persist", {
        ok: ok, error: error, key: LL_WALLPAPER_KEY, valueLen: valueLen,
        revOk: revOk, revError: revError
    });
    if (broadcast !== false) {
        window.__liuliPaletteApplied = false;
        applyDynamicPalette();
    }
    return { ok: ok, error: error };
}

/* 图片宽高比缓存：按 src 存，避免异步竞态拿到旧图的比例 */
const llImageRatioCache = new Map();
function getImageRatio(src) {
    return llImageRatioCache.get(src) || null;
}
// 让诊断快照能读到 imageRatioCached（diag.js 不直接依赖本模块）
setImageRatioReader(getImageRatio);
function primeImageRatio(src) {
    return new Promise(function (resolve) {
        const img = new Image();
        img.onload = function () {
            const r = img.naturalWidth > 0 && img.naturalHeight > 0
                ? img.naturalWidth / img.naturalHeight : null;
            if (r) llImageRatioCache.set(src, r);
            resolve(r);
        };
        img.onerror = function () { resolve(null); };
        img.src = src;
    });
}

/* #37：启动路径补算比例用。同一个 src 只解码一次（复用同一个 Promise，
 * 失败结果也记住），避免 onerror 的坏图在「启动 → 600ms 兜底 → 轮询」之间
 * 被反复重试，也避免并发调用各拿到一份不一致的结果。 */
const llWpRatioTried = new Map();     // src -> Promise<ratio|null>（已发起/已完成的解码）
const llWpRatioFailed = new Set();    // 解码失败（onerror）的 src：渲染时只能退回 cover
function primeWallpaperRatioOnce(src) {
    const known = getImageRatio(src);
    if (known) return Promise.resolve(known);
    const hit = llWpRatioTried.get(src);
    if (hit) return hit;
    if (llWpRatioTried.size > 8) { llWpRatioTried.clear(); llWpRatioFailed.clear(); }
    const p = primeImageRatio(src).then(function (r) {
        if (r) llWpRatioFailed.delete(src); else llWpRatioFailed.add(src);
        return r;
    });
    llWpRatioTried.set(src, p);
    return p;
}

/* ── 把选区按指定比例归一化：保留面积与中心，两维恒 ≤ 0.998 ── */
function normalizeAreaToRatio(area, ratio) {
    const safeRatio = Math.max(0.05, Math.min(20, ratio));
    const areaSize = Math.max(area.w * area.h, 0.04 * 0.04);
    let w = Math.sqrt(areaSize * safeRatio);
    let h = Math.sqrt(areaSize / safeRatio);
    const scale = Math.min(1, 1 / w, 1 / h);
    w *= scale;
    h *= scale;
    const maxDim = Math.max(w, h);
    if (maxDim > 0.998) {
        const shrink = 0.998 / maxDim;
        w *= shrink;
        h *= shrink;
    }
    const cx = area.x + area.w / 2;
    const cy = area.y + area.h / 2;
    return {
        x: Math.min(1 - w, Math.max(0, cx - w / 2)),
        y: Math.min(1 - h, Math.max(0, cy - h / 2)),
        w: w,
        h: h
    };
}

/* ── 由选区推导 background-size / position ──
 * cover 选区放大公式：size = 100%/w 100%/h；position = x/(1-w) y/(1-h)
 * 返回 null 表示「这一帧算不出可信的几何」，调用方自己决定跳过还是退回 cover。 */
function bgGeometry(area, imageRatio, viewportRatio) {
    if (arguments[3] === "contain") return { size: "contain", position: "center" };
    if (arguments[3] === "stretch") return { size: "100% 100%", position: "center" };
    if (!area || area.w <= 0.04 || area.h <= 0.04) {
        return { size: "cover", position: "center" };
    }
    const vRatio = viewportRatio && viewportRatio > 0 ? viewportRatio : window.innerWidth / window.innerHeight;
    /* #37：有选区、但图片比例还没解码出来时，**不能**拿视口比例顶替。
     * 顶替后 vRatio / iRatio 恒为 1，normalizeAreaToRatio() 会把选区按 1:1 归一化成
     * 正方形，算出来的 background-size 就是用户看到的「重启 QQ 后壁纸变拉伸」。
     * 这里返回 null，让调用方等比例就绪后再画（宁可白一帧也不画错）。 */
    if (!(imageRatio && imageRatio > 0)) return null;
    const n = normalizeAreaToRatio(area, vRatio / imageRatio);
    if (n.w >= 0.999 || n.h >= 0.999) {
        return { size: "cover", position: "center" };
    }
    const px = Math.min(1, Math.max(0, n.x / (1 - n.w)));
    const py = Math.min(1, Math.max(0, n.y / (1 - n.h)));
    return {
        size: "calc(100% / " + n.w + ") calc(100% / " + n.h + ")",
        position: (px * 100).toFixed(2) + "% " + (py * 100).toFixed(2) + "%"
    };
}

function ensureWallpaperStyle() {
    let el = document.getElementById("liuli-wallpaper-style");
    if (!el) {
        el = document.createElement("style");
        el.id = "liuli-wallpaper-style";
        document.head.appendChild(el);
    }
    return el;
}

function renderWallpaper(state, reason) {
    const el = ensureWallpaperStyle();
    llWpLast = state;
    if (!state || !state.src) {
        el.textContent = "";
        // 只有明确"为什么渲染"时才写审计（resize 之类的重绘不刷屏）
        if (reason) {
            auditWallpaper("apply", {
                scope: llScopeName(), styleLen: 0, ratioKnown: false,
                fit: (state && state.fit) || "cover", area: null,
                cleared: true, reason: reason, rev: llWallpaperRev()
            });
        }
        return;
    }
    const ir = getImageRatio(state.src);
    let g = bgGeometry(state.area, ir, window.innerWidth / window.innerHeight, state.fit || "cover");
    if (!g) {
        /* #37：有选区、比例未就绪（启动那一帧必然如此）。这一帧先不落笔，
         * 由 primeWallpaperRatioOnce() 就绪后的那次渲染补上——宁可白一帧也不画成拉伸。
         * 只有确定解码失败（onerror）的图才退回整块 cover：铺满、但不变形。 */
        if (!llWpRatioFailed.has(state.src)) {
            if (reason) {
                auditWallpaper("apply", {
                    scope: llScopeName(), styleLen: el.textContent.length, ratioKnown: false,
                    fit: state.fit || "cover", area: state.area || null,
                    skipped: "area-ratio-unknown", reason: reason, rev: llWallpaperRev()
                });
            }
            return;
        }
        g = { size: "cover", position: "center" };
    }
    el.textContent =
        // 伪元素的骨架也写在这里：以前只在默认壁纸 wallpaper.css 里，
        // 默认壁纸不再发布后，没有 content 的 ::before 不会画出来。
        "#app::before {" +
        "  content: \"\" !important; position: absolute !important; inset: 0 !important;" +
        "  z-index: 0 !important; pointer-events: none !important;" +
        "  background-image: linear-gradient(rgba(var(--ll-veil-rgb, var(--ll-scrim-rgb)), var(--ll-wallpaper-dim, 0.18))," +
        "    rgba(var(--ll-veil-rgb, var(--ll-scrim-rgb)), var(--ll-wallpaper-dim, 0.18))),\n" +
        "    url(\"" + state.src + "\") !important;" +
        "  background-position: " + g.position + " !important;" +
        "  background-size: " + g.size + " !important;" +
        "  background-repeat: no-repeat !important;" +
        "}";
    if (reason) {
        auditWallpaper("apply", {
            scope: llScopeName(), styleLen: el.textContent.length,
            ratioKnown: !!getImageRatio(state.src), fit: state.fit || "cover",
            area: state.area || null, reason: reason, rev: llWallpaperRev()
        });
    }
}

/* 启动兜底（契约第四节第 4 条）：localStorage 里明明有壁纸，但 #app::before
 * 没有背景图（样式注入过早/被覆盖），600ms 后再渲染一次。 */
function llWallpaperPseudoApplied() {
    try {
        const app = document.getElementById("app");
        if (!app) return false;
        const cs = getComputedStyle(app, "::before");
        return !!cs && (cs.backgroundImage || "").indexOf("url(") >= 0;
    } catch (e) {
        return false;
    }
}

function scheduleWallpaperBootRetry() {
    setTimeout(function () {
        try {
            const st = loadWallpaperState();
            if (!st || !st.src) return;
            const ir = getImageRatio(st.src);
            /* #37：旧判据只看「#app::before 有没有 url(」。可启动时背景图早就画上去了
             * （只是有选区、比例未知，background-size 算歪了），于是这里提前 return，
             * 永远不会补救。有选区而比例仍未知，也必须重算一次。 */
            const needRatio = !!(st.area && !ir);
            if (llWallpaperPseudoApplied() && !needRatio) return;
            console.warn("[liuli-dsh-theme] 壁纸启动渲染不完整（#37），重渲染一次");
            renderWallpaper(st, "boot-retry");
            if (needRatio) {
                primeWallpaperRatioOnce(st.src).then(function (r) {
                    if (r) renderWallpaper(loadWallpaperState(), "ratio-primed");
                });
            }
            window.__liuliPaletteApplied = false;
            applyDynamicPalette();
        } catch (e) { /* 静默 */ }
    }, 600);
}

/* 窗口拉伸：选区算出的 background-size 是按当时的窗口比例定的，比例一变图就被拉歪。
 * 每次尺寸变化按新比例重算一遍（每帧最多一次，用内存里的状态，不重复解析 localStorage 里的大图）。 */
let llWpLast = null;
let llWpResizeRaf = 0;
try {
    window.addEventListener("resize", function () {
        if (llWpResizeRaf || !llWpLast || !llWpLast.src) return;
        llWpResizeRaf = requestAnimationFrame(function () {
            llWpResizeRaf = 0;
            renderWallpaper(llWpLast);
        });
    });
} catch (e) {}

/* 跨窗口同步（设置页改 → 主界面跟着换） */
try {
    window.addEventListener("storage", function (e) {
        if (e.key !== LL_WALLPAPER_KEY) return;
        const st = loadWallpaperState();
        auditWallpaper("storage", {
            scope: llScopeName(), key: LL_WALLPAPER_KEY, hasSrc: !!(st && st.src)
        });
        // storage 事件已经到了，就把 revision 记成最新：1500ms 轮询不用再重复渲染一次大图
        try {
            const rev = localStorage.getItem(LL_WALLPAPER_REV_KEY);
            if (rev) llWpRevSeen = rev;
        } catch (err) {}
        if (st.src && !getImageRatio(st.src)) {
            primeImageRatio(st.src).then(function () {
                renderWallpaper(loadWallpaperState(), "storage");
                refreshWallpaperPreview();
            });
        }
        renderWallpaper(st, "storage");
        window.__liuliPaletteApplied = false;
        applyDynamicPalette();
        if (typeof refreshWallpaperPreview === "function") refreshWallpaperPreview();
    });
} catch (e) {}

/* revision 轮询兜底（契约第四节第 3 条）：
 * 设置窗口和主窗口可能不在同一个 session，storage 事件根本到不了。
 * 主窗口只读这个小键（毫秒字符串），变了才 loadWallpaperState + renderWallpaper，
 * 大图 dataURL 只在真正需要时才解析。 */
let llWpRevSeen = "";
try { llWpRevSeen = localStorage.getItem(LL_WALLPAPER_REV_KEY) || ""; } catch (e) {}
setInterval(function () {
    try {
        if (!document.body || document.body.dataset.liuliScope !== "main") return;
        const rev = localStorage.getItem(LL_WALLPAPER_REV_KEY) || "";
        if (rev === llWpRevSeen) return;
        const fromRev = llWpRevSeen;
        llWpRevSeen = rev;
        if (!rev) return;
        auditWallpaper("poll", { fromRev: fromRev, toRev: rev, scope: llScopeName() });
        const st = loadWallpaperState();
        if (st.src && !getImageRatio(st.src)) {
            primeImageRatio(st.src).then(function () {
                renderWallpaper(loadWallpaperState(), "poll");
                refreshWallpaperPreview();
            });
        }
        renderWallpaper(st, "poll");
        refreshWallpaperPreview();
        window.__liuliPaletteApplied = false;
        applyDynamicPalette();
    } catch (e) { /* 静默 */ }
}, 1500);

/* 选图压缩：自适应宽度与质量（契约第四节第 2 条）。
 * 目标 dataURL ≤3.5MB：2560 → 1920 → 1440 → 1080 宽、质量 0.86 → 0.8；
 * 全部档位都超限时仍返回最小结果（over=true），由调用方提示并允许保存。 */
const LL_WP_DATAURL_BUDGET = 3.5 * 1024 * 1024;
const LL_WP_ENCODE_WIDTHS = [2560, 1920, 1440, 1080];
const LL_WP_ENCODE_QUALITIES = [0.86, 0.8];

function llReadFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onerror = function () { reject(new Error("读取文件失败")); };
        reader.onload = function () { resolve(String(reader.result || "")); };
        reader.readAsDataURL(file);
    });
}

function llDecodeImage(src) {
    return new Promise(function (resolve, reject) {
        const img = new Image();
        img.onerror = function () { reject(new Error("图片解码失败")); };
        img.onload = function () { resolve(img); };
        img.src = src;
    });
}

async function readImageFile(file, maxW) {
    const started = Date.now();
    try {
        const raw = await llReadFileAsDataUrl(file);
        const img = await llDecodeImage(raw);
        const cap = Number(maxW) > 0 ? Number(maxW) : LL_WP_ENCODE_WIDTHS[0];
        // 候选宽度：原图（不超过上限）优先，再按 2560→1080 逐档压缩。
        // 之前直接取 <=2560 的档位，小图（如 1200 宽）会被无谓缩到 1080，白白损失清晰度。
        const widths = [];
        if (img.naturalWidth > 0 && img.naturalWidth <= cap) widths.push(img.naturalWidth);
        for (const w of LL_WP_ENCODE_WIDTHS) {
            if (w <= cap && widths.indexOf(w) < 0) widths.push(w);
        }
        if (!widths.length) widths.push(cap);
        const tries = [];
        let last = null;
        let prevDims = "";
        for (const targetW of widths) {
            const sc = Math.min(1, targetW / img.naturalWidth);
            const w = Math.max(1, Math.round(img.naturalWidth * sc));
            const h = Math.max(1, Math.round(img.naturalHeight * sc));
            const dims = w + "x" + h;
            if (dims === prevDims) continue;   // 原图比目标宽还小：同一尺寸没必要重复编码
            prevDims = dims;
            const cvs = document.createElement("canvas");
            cvs.width = w;
            cvs.height = h;
            const ctx = cvs.getContext("2d");
            if (!ctx) throw new Error("canvas 2d 不可用");
            ctx.drawImage(img, 0, 0, w, h);
            for (const q of LL_WP_ENCODE_QUALITIES) {
                const dataUrl = cvs.toDataURL("image/jpeg", q);
                tries.push({ w: w, q: q, len: dataUrl.length });
                last = { dataUrl: dataUrl, ratio: w / h, width: w, height: h, quality: q };
                if (dataUrl.length <= LL_WP_DATAURL_BUDGET) {
                    auditWallpaper("encode", {
                        ok: true, dataUrlLen: dataUrl.length, width: w, height: h,
                        quality: q, ms: Date.now() - started, tries: tries
                    });
                    return last;
                }
            }
        }
        if (!last) throw new Error("没有可用的编码结果");
        const over = last.dataUrl.length > LL_WP_DATAURL_BUDGET;
        auditWallpaper("encode", {
            ok: true, dataUrlLen: last.dataUrl.length, width: last.width, height: last.height,
            quality: last.quality, ms: Date.now() - started, over: over, tries: tries
        });
        return Object.assign({ over: over }, last);
    } catch (e) {
        auditWallpaper("encode", { ok: false, error: llErrText(e), ms: Date.now() - started });
        throw e;
    }
}

/* ════════════════════════════════════════════════════════════
 * 壁纸预览（非选择态）+ 框选编辑（选择态）
 * ════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════
 * 壁纸设置（照搬 DSH LiuliAppearance.tsx 的 WallpaperPreview）
 * ------------------------------------------------------------
 *   - 卡片内：选择图片 / 移除 · 适应模式（Cover/Contain/Stretch）· 预览
 *   - 预览按实际窗口比例渲染，所见即所得
 *   - Cover 下可「编辑选区」：容器按完整壁纸比例显示，选框恒定窗口比例，
 *     拖空白新建、拖框内移动、拖四角缩放，点「完成选区」保存
 *   - 换图后立刻按新壁纸重新取色（extractSource 读的就是当前壁纸）
 * ════════════════════════════════════════════════════════════ */
let wpPreviewEl = null;
let llWpRefresh = null;
function refreshWallpaperPreview() { if (llWpRefresh) llWpRefresh(); }

const LL_WP_FITS = [["cover", "填充（Cover）"], ["contain", "适应（Contain）"], ["stretch", "拉伸（Stretch）"]];

function llBtn(text, variant) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "liuli-btn liuli-btn--" + (variant || "ghost");
    b.textContent = text;
    return b;
}

function llApplyWallpaper(st) {
    const saved = saveWallpaperState(st, true);
    if (st && st.src && !getImageRatio(st.src)) {
        primeImageRatio(st.src).then(function () { renderWallpaper(loadWallpaperState(), "user"); refreshWallpaperPreview(); });
    }
    renderWallpaper(st, "user");
    refreshWallpaperPreview();
    if (!saved.ok) {
        // 契约第四节第 1 条：不再静默；把异常名/消息直接告诉用户
        toast("壁纸保存失败：" + saved.error + "（仅本次生效，重启后可能丢失）");
    }
    return saved;
}

/* 主界面视口比例：壁纸铺在主聊天界面上，预览/框选必须按主界面的实时宽高比算，
 * 不能用设置窗口自己的 innerWidth/innerHeight（之前就是这个错）。
 * 主界面在加载和 resize 时把尺寸写进 localStorage，其它窗口读它并监听 storage 事件。 */
const LL_MAIN_VP_KEY = "liuli-dsh-main-viewport";
function llMainViewportRatio() {
    if (document.body && document.body.dataset.liuliScope === "main") return window.innerWidth / window.innerHeight;
    try {
        const v = JSON.parse(localStorage.getItem(LL_MAIN_VP_KEY) || "null");
        if (v && v.w > 0 && v.h > 0) return v.w / v.h;
    } catch (e) {}
    return window.innerWidth / window.innerHeight;
}
(function publishMainViewport() {
    let t = 0;
    function pub() {
        if (!document.body || document.body.dataset.liuliScope !== "main") return;
        try {
            const cur = JSON.parse(localStorage.getItem(LL_MAIN_VP_KEY) || "null");
            if (cur && cur.w === innerWidth && cur.h === innerHeight) return;
            localStorage.setItem(LL_MAIN_VP_KEY, JSON.stringify({ w: innerWidth, h: innerHeight }));
        } catch (e) {}
    }
    try {
        window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(pub, 80); });
        setTimeout(pub, 500);
        setInterval(pub, 3000);
        window.addEventListener("storage", function (e) {
            if (e.key === LL_MAIN_VP_KEY && typeof refreshWallpaperPreview === "function") refreshWallpaperPreview();
        });
    } catch (e) {}
})();

function buildWallpaperControls(host) {
    const block = document.createElement("div");
    block.className = "liuli-wp-block";
    host.appendChild(block);

    const title = document.createElement("div");
    title.className = "liuli-wp-title";
    title.textContent = "壁纸设置";
    block.appendChild(title);

    /* ── 选择 / 移除 ── */
    const row = document.createElement("div");
    row.className = "liuli-wp-actions";
    const pick = document.createElement("input");
    pick.type = "file";
    pick.accept = "image/*";
    pick.style.display = "none";
    const chooseBtn = llBtn("选择图片", "primary");
    chooseBtn.addEventListener("click", function () { pick.click(); });
    const fileName = document.createElement("span");
    fileName.className = "liuli-wp-filename";
    const removeBtn = llBtn("移除", "ghost");
    removeBtn.addEventListener("click", function () {
        let ok = true;
        let error = "";
        try {
            localStorage.removeItem(LL_WALLPAPER_KEY);
            // 写 revision 让主窗口的轮询也能收到"移除"（只删大键的话轮询会以为没变化）
            localStorage.setItem(LL_WALLPAPER_REV_KEY, String(Date.now()));
        } catch (e) {
            ok = false;
            error = llErrText(e);
        }
        auditWallpaper("remove", { ok: ok, error: error });
        renderWallpaper(null, "remove");
        window.__liuliPaletteApplied = false;
        applyDynamicPalette();
        fileName.textContent = "";
        refreshWallpaperPreview();
        toast(ok ? "已恢复默认壁纸" : "移除壁纸失败：" + error);
    });
    pick.addEventListener("change", function () {
        const f = pick.files && pick.files[0];
        if (!f) return;
        auditWallpaper("pick", {
            file: { name: String(f.name || ""), size: Number(f.size) || 0, type: String(f.type || "") },
            maxW: 2560
        });
        chooseBtn.disabled = true;
        chooseBtn.textContent = "读取中…";
        readImageFile(f, 2560).then(function (r) {
            llImageRatioCache.set(r.dataUrl, r.ratio);
            const prev = loadWallpaperState();
            llApplyWallpaper({ src: r.dataUrl, area: null, fit: prev.fit || "cover" });
            fileName.textContent = f.name;
            if (r.over) {
                toast("壁纸已更新，但压到最小仍约 " + llFmtBytes(r.dataUrl.length) + "，若显示异常请换一张更小的图");
            } else {
                toast("壁纸已更新，主题色已按新壁纸取色");
            }
            if (llModeAdviceRefresh) llModeAdviceRefresh();
        }).catch(function (e) {
            toast("读取失败：" + llErrText(e));
        }).finally(function () {
            chooseBtn.disabled = false;
            chooseBtn.textContent = "选择图片";
            pick.value = "";
        });
    });
    row.appendChild(chooseBtn);
    row.appendChild(removeBtn);
    row.appendChild(fileName);
    row.appendChild(pick);
    block.appendChild(row);

    /* 壁纸亮度和明暗主题不搭时给一句提示（#7） */
    const advice = document.createElement("div");
    advice.className = "liuli-wp-advice";
    advice.hidden = true;
    block.appendChild(advice);
    llModeAdviceRefresh = function () { return llCheckModeAdvice(advice); };
    llModeAdviceRefresh();

    /* ── 适应模式 ── */
    const fitRow = document.createElement("div");
    fitRow.className = "liuli-wp-fit";
    const fitLabel = document.createElement("span");
    fitLabel.textContent = "适应模式";
    const fitSeg = document.createElement("div");
    fitSeg.className = "liuli-seg";
    fitRow.appendChild(fitLabel);
    fitRow.appendChild(fitSeg);
    block.appendChild(fitRow);
    const fitBtns = {};
    LL_WP_FITS.forEach(function (p) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "liuli-seg__item";
        b.textContent = p[1];
        b.addEventListener("click", function () {
            const st = loadWallpaperState();
            st.fit = p[0];
            llApplyWallpaper(st);
        });
        fitSeg.appendChild(b);
        fitBtns[p[0]] = b;
    });

    /* ── 预览 ── */
    const previewActions = document.createElement("div");
    previewActions.className = "liuli-wp-actions";
    const previewHost = document.createElement("div");
    previewHost.className = "liuli-wp-preview-host";
    const note = document.createElement("div");
    note.className = "liuli-wp-note";
    note.textContent = "选区仅 Cover 模式生效";
    block.appendChild(previewActions);
    block.appendChild(previewHost);
    block.appendChild(note);

    let selectMode = false;
    let selBox = null;
    let drag = null;
    let stage = null;

    const winRatio = llMainViewportRatio;
    const clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
    const cropRatioOf = function (ir) { return ir && ir > 0 ? winRatio() / ir : 1; };

    function windowArea(ir) {
        if (!ir || ir <= 0) return null;
        const wr = winRatio();
        const maxW = Math.min(0.998, ir > wr ? wr / ir : 1);
        const maxH = Math.min(0.998, ir > wr ? 1 : ir / wr);
        return { x: (1 - maxW) / 2, y: (1 - maxH) / 2, w: maxW, h: maxH };
    }
    function createArea(start, p, ratio) {
        const r = Math.max(0.05, Math.min(20, ratio));
        const dx = p.x - start.x, dy = p.y - start.y;
        const dirX = dx >= 0 ? 1 : -1, dirY = dy >= 0 ? 1 : -1;
        const maxW = dirX > 0 ? 1 - start.x : start.x;
        const maxH = dirY > 0 ? 1 - start.y : start.y;
        const w = Math.min(Math.max(Math.abs(dx), Math.abs(dy) * r), maxW, maxH * r);
        const h = w / r;
        return { x: dirX > 0 ? start.x : start.x - w, y: dirY > 0 ? start.y : start.y - h, w: w, h: h };
    }
    function resizeArea(box, corner, p, ratio) {
        const r = Math.max(0.05, Math.min(20, ratio));
        const fx = (corner === "tl" || corner === "bl") ? box.x + box.w : box.x;
        const fy = (corner === "tl" || corner === "tr") ? box.y + box.h : box.y;
        const dirX = (corner === "tr" || corner === "br") ? 1 : -1;
        const dirY = (corner === "bl" || corner === "br") ? 1 : -1;
        const maxW = dirX > 0 ? 1 - fx : fx;
        const maxH = dirY > 0 ? 1 - fy : fy;
        const w = Math.min(Math.max(Math.abs(p.x - fx), Math.abs(p.y - fy) * r), maxW, maxH * r);
        const h = w / r;
        return { x: dirX > 0 ? fx : fx - w, y: dirY > 0 ? fy : fy - h, w: w, h: h };
    }
    function norm(e) {
        if (!stage) return null;
        const r = stage.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
    }

    function cropBoxEl(box, interactive) {
        const el = document.createElement("div");
        el.className = "liuli-wp-crop" + (interactive ? "" : " liuli-wp-crop--static");
        el.style.left = box.x * 100 + "%";
        el.style.top = box.y * 100 + "%";
        el.style.width = box.w * 100 + "%";
        el.style.height = box.h * 100 + "%";
        if (interactive) {
            ["tl", "tr", "bl", "br"].forEach(function (c) {
                const h = document.createElement("span");
                h.className = "liuli-wp-handle liuli-wp-handle--" + c;
                el.appendChild(h);
            });
        }
        return el;
    }

    function paintSelection() {
        if (!stage) return;
        const old = stage.querySelector(".liuli-wp-crop");
        if (old) old.remove();
        if (selBox && selBox.w > 0) stage.appendChild(cropBoxEl(selBox, true));
    }

    function render() {
        const st = loadWallpaperState();
        const fit = st.fit || "cover";
        Object.keys(fitBtns).forEach(function (k) { fitBtns[k].classList.toggle("is-active", k === fit); });
        removeBtn.disabled = !st.src;
        previewActions.innerHTML = "";
        previewHost.innerHTML = "";
        stage = null;
        note.style.display = st.src && fit !== "cover" ? "" : "none";
        if (!st.src) {
            previewHost.style.display = "none";
            previewActions.style.display = "none";
            return;
        }
        previewHost.style.display = "";
        previewActions.style.display = "";
        const ir = getImageRatio(st.src);
        if (!ir) { primeImageRatio(st.src).then(render); }
        const wr = winRatio();
        const width = "min(100%, calc(220px * " + wr + "))";
        const cr = cropRatioOf(ir);

        if (selectMode) {
            const reselect = llBtn("重新选择", "ghost");
            reselect.addEventListener("click", function () { selBox = windowArea(ir); paintSelection(); });
            const done = llBtn("完成选区", "primary");
            done.addEventListener("click", function () {
                if (selBox && selBox.w > 0.04 && selBox.h > 0.04) {
                    const cur = loadWallpaperState();
                    cur.area = normalizeAreaToRatio(selBox, cr);
                    llApplyWallpaper(cur);
                }
                selectMode = false;
                selBox = null;
                render();
            });
            previewActions.appendChild(reselect);
            previewActions.appendChild(done);
        } else {
            const edit = llBtn(st.area ? "编辑选区" : "重新选择", "ghost");
            edit.disabled = fit !== "cover" || !ir;
            edit.addEventListener("click", function () {
                const saved = st.area && st.area.w > 0.04 && st.area.h > 0.04 ? normalizeAreaToRatio(st.area, cr) : null;
                selBox = saved || windowArea(ir);
                selectMode = true;
                render();
            });
            previewActions.appendChild(edit);
            if (st.area) {
                const clear = llBtn("清除选区", "ghost");
                clear.addEventListener("click", function () {
                    const cur = loadWallpaperState();
                    cur.area = null;
                    llApplyWallpaper(cur);
                });
                previewActions.appendChild(clear);
            }
        }

        const full = document.createElement("div");
        full.className = "liuli-wp-full";
        full.style.backgroundImage = "url(\"" + st.src + "\")";

        if (selectMode && ir) {
            stage = document.createElement("div");
            stage.className = "liuli-wp-context is-selecting";
            stage.style.width = width;
            stage.style.aspectRatio = String(ir);
            stage.appendChild(full);
            previewHost.appendChild(stage);
            paintSelection();
            stage.addEventListener("pointerdown", function (e) {
                e.preventDefault();
                const r = stage.getBoundingClientRect();
                const p0 = norm(e);
                if (!p0) return;
                const box = selBox;
                if (box && box.w > 0) {
                    const L = box.x * r.width, T = box.y * r.height;
                    const R = (box.x + box.w) * r.width, B = (box.y + box.h) * r.height;
                    const lx = e.clientX - r.left, ly = e.clientY - r.top;
                    const dL = Math.abs(lx - L), dR = Math.abs(lx - R), dT = Math.abs(ly - T), dB = Math.abs(ly - B);
                    const nearCorner = (dL < 12 || dR < 12) && (dT < 12 || dB < 12);
                    const nearBox = lx >= L - 6 && lx <= R + 6 && ly >= T - 6 && ly <= B + 6;
                    if (nearCorner) {
                        drag = { mode: "resize", box: box, corner: (dT <= dB ? "t" : "b") + (dL <= dR ? "l" : "r") };
                    } else if (nearBox) {
                        drag = { mode: "move", box: box, ox: clamp(p0.x - box.x, 0, box.w), oy: clamp(p0.y - box.y, 0, box.h) };
                    } else {
                        drag = { mode: "create", start: p0, prev: box };
                        selBox = { x: p0.x, y: p0.y, w: 0, h: 0 };
                    }
                } else {
                    drag = { mode: "create", start: p0, prev: box };
                    selBox = { x: p0.x, y: p0.y, w: 0, h: 0 };
                }
                stage.setPointerCapture(e.pointerId);
                paintSelection();
            });
            stage.addEventListener("pointermove", function (e) {
                if (!drag) return;
                const p = norm(e);
                if (!p) return;
                if (drag.mode === "create") selBox = createArea(drag.start, p, cr);
                else if (drag.mode === "resize") selBox = resizeArea(drag.box, drag.corner, p, cr);
                else selBox = { x: clamp(p.x - drag.ox, 0, 1 - drag.box.w), y: clamp(p.y - drag.oy, 0, 1 - drag.box.h), w: drag.box.w, h: drag.box.h };
                paintSelection();
            });
            const up = function () {
                const d = drag;
                drag = null;
                if (d && d.mode === "create" && !(selBox && selBox.w > 0.04 && selBox.h > 0.04)) {
                    selBox = d.prev;
                    paintSelection();
                }
            };
            stage.addEventListener("pointerup", up);
            stage.addEventListener("pointercancel", up);
        } else if (st.area && fit === "cover" && ir) {
            /* 有选区：完整壁纸 + 静态选框（选区外暗化） */
            stage = document.createElement("div");
            stage.className = "liuli-wp-context";
            stage.style.width = width;
            stage.style.aspectRatio = String(ir);
            stage.appendChild(full);
            stage.appendChild(cropBoxEl(normalizeAreaToRatio(st.area, cr), false));
            previewHost.appendChild(stage);
        } else {
            /* 无选区：按窗口比例渲染真实效果 */
            stage = document.createElement("div");
            stage.className = "liuli-wp-stage2";
            stage.style.width = width;
            stage.style.aspectRatio = String(wr);
            const fx = document.createElement("div");
            fx.className = "liuli-wp-effect";
            // #37：比例还没就绪时 bgGeometry() 返回 null，预览这一帧先按 cover 画，
            // 等 primeImageRatio() 回来重渲染，绝不能按 1:1 归一化（那就是拉伸预览）
            const g = bgGeometry(st.area, ir, wr, fit) || { size: "cover", position: "center" };
            fx.style.backgroundImage = "url(\"" + st.src + "\")";
            fx.style.backgroundSize = g.size;
            fx.style.backgroundPosition = g.position;
            stage.appendChild(fx);
            previewHost.appendChild(stage);
        }
    }

    llWpRefresh = render;
    render();
}

/* ════════════════════════════════════════════════════════════
 * 明暗主题（DSH 的日/夜切换）
 *   跟随 QQ / 亮色 / 暗色，存在 localStorage，所有窗口同步。
 *   色板全部由 MCU 按明暗重新派生（同一套壁纸取色）。
 * ════════════════════════════════════════════════════════════ */
const LL_MODE_KEY = "liuli-dsh-mode";
function llThemeMode() {
    try {
        const v = localStorage.getItem(LL_MODE_KEY);
        return v === "light" || v === "dark" ? v : "auto";
    } catch (e) { return "auto"; }
}
function llIsDark() {
    const m = llThemeMode();
    if (m === "light") return false;
    if (m === "dark") return true;
    return document.body.classList.contains("q-theme-tokens-dark")
        || document.body.getAttribute("q-theme") === "dark";
}
function llApplyMode(withTransition, x, y) {
    const run = function () {
        const m = llThemeMode();
        if (m === "auto") delete document.body.dataset.liuliMode;
        else document.body.dataset.liuliMode = m;
        document.body.dataset.liuliDark = llIsDark() ? "1" : "0";
        window.__liuliPaletteApplied = false;
        return applyDynamicPalette();
    };
    if (withTransition && typeof document.startViewTransition === "function") {
        const root = document.documentElement;
        root.style.setProperty("--vt-x", (x || innerWidth / 2) + "px");
        root.style.setProperty("--vt-y", (y || innerHeight / 2) + "px");
        root.style.setProperty("--vt-r", Math.hypot(innerWidth, innerHeight) + "px");
        document.startViewTransition(run);
    } else {
        run();
    }
}
try {
    window.addEventListener("storage", function (e) {
        if (e.key === LL_MODE_KEY) { llApplyMode(false); if (typeof llModeRefresh === "function") llModeRefresh(); }
        // 配色（颜色角色）在别的窗口改了：重新派生一次色板
        if (e.key === ROLE_KEY) { window.__liuliPaletteApplied = false; applyDynamicPalette(); }
    });
} catch (e) {}
let llModeRefresh = null;
try {
    new MutationObserver(function () {
        if (llThemeMode() !== "auto") return;
        const d = llIsDark() ? "1" : "0";
        if (document.body.dataset.liuliDark !== d) llApplyMode(false);
    }).observe(document.body, { attributes: true, attributeFilter: ["q-theme", "class"] });
} catch (e) {}

/* ---------- 壁纸亮度 → 明暗主题建议（#7） ----------
 * 会话列表、侧栏这些玻璃层是「亚克力 × 不透明度 + 压暗后的壁纸 × (1 - 不透明度)」，
 * 文字就压在这层混合色上。亮色主题配暗壁纸时混出来是灰的，深色字看不清；反过来同理。
 * 这里按壁纸平均亮度、两种模式各自的「壁纸遮罩浓度 + 遮罩颜色」和「不透明度」
 * 估算两种主题下的文字对比度，
 * 当前主题低于 4.5:1、另一种明显更好（≥1.5 倍）时提示切换。只提示，不自动改。 */
const LL_WP_ADVICE_KEY = "liuli-wp-advice-dismissed";
let llModeAdviceRefresh = null;
const llSrgbToY = s => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
const llYToSrgb = y => (y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055);
const llLstarToY = l => (l > 8 ? Math.pow((l + 16) / 116, 3) : l / 903.3);

function llWallpaperFingerprint(src) {
    return src ? src.length + ":" + src.slice(-48) : "";
}

/* 壁纸平均相对亮度（0~1），缩到 48×48 采样 */
async function llWallpaperLuma(src) {
    const img = await llDecodeImage(src);
    const n = 48;
    const c = document.createElement("canvas");
    c.width = n; c.height = n;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, n, n);
    const px = ctx.getImageData(0, 0, n, n).data;
    let sum = 0, cnt = 0;
    for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 128) continue;
        sum += 0.2126 * llSrgbToY(px[i] / 255) + 0.7152 * llSrgbToY(px[i + 1] / 255) + 0.0722 * llSrgbToY(px[i + 2] / 255);
        cnt++;
    }
    return cnt ? sum / cnt : 0.5;
}

/* 估算某种主题下玻璃层上正文的对比度。混合按 sRGB 做（和浏览器合成一致）；
 * 玻璃 / 正文的明度取 M3 的 surface（亮 94 / 暗 12）和 onSurface（亮 10 / 暗 90）。
 * dim / veil 是「目标模式」自己的那一份（需求 A.5）：
 *   veil = "light" → 遮罩取 L*98 的纸白；veil = "dark" → 遮罩取黑。 */
function llModeContrast(wallY, dim, opacity, dark, veil) {
    const veilSrgb = veil === "light" ? llYToSrgb(llLstarToY(98)) : 0;
    const wall = llYToSrgb(wallY) * (1 - dim) + veilSrgb * dim;
    const glass = llYToSrgb(llLstarToY(dark ? 12 : 94));
    const bgY = llSrgbToY(glass * opacity + wall * (1 - opacity));
    const textY = llLstarToY(dark ? 90 : 10);
    return (Math.max(bgY, textY) + 0.05) / (Math.min(bgY, textY) + 0.05);
}

async function llCheckModeAdvice(box) {
    box.hidden = true;
    box.textContent = "";
    let src = null;
    try { const st = loadWallpaperState(); src = st && st.src; } catch (e) {}
    if (!src) return null;
    const fp = llWallpaperFingerprint(src);
    const dark = llIsDark();
    try { if (localStorage.getItem(LL_WP_ADVICE_KEY) === fp + "|" + (dark ? "dark" : "light")) return null; } catch (e) {}
    let y;
    try { y = await llWallpaperLuma(src); } catch (e) { return null; }
    // 两种模式各按自己的遮罩浓度 / 遮罩颜色估（body 上只有当前模式那一份，所以取配置）
    const cfg = llModeCfg || DEFAULT_SETTINGS;
    const op = Number(cfg.opacity);
    const o = isFinite(op) ? op : 0.5;
    const cur = llModeContrast(y, llDimFor(cfg, dark), o, dark, llVeilFor(cfg, dark));
    const alt = llModeContrast(y, llDimFor(cfg, !dark), o, !dark, llVeilFor(cfg, !dark));
    const result = { luma: y, current: cur, other: alt, advise: cur < 4.5 && alt >= cur * 1.5 };
    if (!result.advise) return result;

    const target = dark ? "light" : "dark";
    const msg = document.createElement("div");
    msg.className = "liuli-wp-advice__text";
    msg.textContent = (dark ? "这张壁纸偏亮，暗色主题下的浅色文字不够清楚" : "这张壁纸偏暗，亮色主题下的深色文字不够清楚")
        + "（估算对比度 " + cur.toFixed(1) + ":1）。换成" + (dark ? "亮色" : "暗色") + "主题约 " + alt.toFixed(1) + ":1。";
    const acts = document.createElement("div");
    acts.className = "liuli-wp-actions";
    const go = llBtn("切换为" + (dark ? "亮色" : "暗色"), "primary");
    go.addEventListener("click", function (e) {
        try { localStorage.setItem(LL_MODE_KEY, target); } catch (err) {}
        llApplyMode(true, e.clientX, e.clientY);
        if (typeof llModeRefresh === "function") llModeRefresh();
        box.hidden = true;
    });
    const keep = llBtn("保持现状", "ghost");
    keep.addEventListener("click", function () {
        try { localStorage.setItem(LL_WP_ADVICE_KEY, fp + "|" + (dark ? "dark" : "light")); } catch (err) {}
        box.hidden = true;
    });
    acts.appendChild(go);
    acts.appendChild(keep);
    box.appendChild(msg);
    box.appendChild(acts);
    box.hidden = false;
    return result;
}
window.__liuliModeAdvice = function () {
    // 调试入口：返回当前壁纸在两种主题下的估算对比度
    const box = document.createElement("div");
    return llCheckModeAdvice(box).then(function (r) { return r && { luma: +r.luma.toFixed(3), current: +r.current.toFixed(2), other: +r.other.toFixed(2), advise: r.advise }; });
};

function buildModeControls(host) {
    const row = document.createElement("div");
    row.className = "liuli-wp-fit liuli-mode-row";
    const label = document.createElement("span");
    label.textContent = "明暗主题";
    const seg = document.createElement("div");
    seg.className = "liuli-seg";
    row.appendChild(label);
    row.appendChild(seg);
    host.appendChild(row);
    const btns = {};
    [["auto", "跟随 QQ"], ["light", "亮色"], ["dark", "暗色"]].forEach(function (p) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "liuli-seg__item";
        b.textContent = p[1];
        b.addEventListener("click", function (e) {
            try {
                if (p[0] === "auto") localStorage.removeItem(LL_MODE_KEY);
                else localStorage.setItem(LL_MODE_KEY, p[0]);
            } catch (err) {}
            llApplyMode(true, e.clientX, e.clientY);
            refresh();
            if (llModeAdviceRefresh) llModeAdviceRefresh();
        });
        seg.appendChild(b);
        btns[p[0]] = b;
    });
    function refresh() {
        const m = llThemeMode();
        Object.keys(btns).forEach(function (k) { btns[k].classList.toggle("is-active", k === m); });
    }
    llModeRefresh = refresh;
    refresh();
}

/* ════════════════════════════════════════════════════════════
 * 诊断（契约 3.5）：设置页「诊断」小节
 * ------------------------------------------------------------
 * 放在「恢复默认」之前。导出流程：
 *   collectDiagnostics(opts) → window.liuli_api.diagExport(payload)
 *   → 展示主进程返回的最终路径；失败 toast + 审计，不静默。
 * preload / main 侧的 diagExport 由另一位同事实现（契约 3.1），
 * 这里在接口不存在时给明确提示，方便判断是不是装到了旧版。
 * ════════════════════════════════════════════════════════════ */
function buildDiagSection(host) {
    const block = document.createElement("div");
    block.className = "liuli-wp-block liuli-diag";
    host.appendChild(block);

    const title = document.createElement("div");
    title.className = "liuli-wp-title";
    title.textContent = "诊断";
    block.appendChild(title);

    const desc = document.createElement("div");
    desc.className = "liuli-diag-desc";
    desc.textContent = "把环境、插件状态、日志、UI/壁纸状态打成 zip（不含聊天记录；设置页截图默认包含）。遇到「启动报错」「换了壁纸不显示」「设置页像原生控件」时，导出这个包发给开发者即可。";
    block.appendChild(desc);

    const checkRow = document.createElement("label");
    checkRow.className = "liuli-diag-check";
    const shots = document.createElement("input");
    shots.type = "checkbox";
    shots.checked = false;                       // 默认不勾：可能含当前聊天画面
    const shotsText = document.createElement("span");
    shotsText.textContent = "包含聊天窗口截图（可能包含当前聊天画面）";
    checkRow.appendChild(shots);
    checkRow.appendChild(shotsText);
    block.appendChild(checkRow);

    const shotsHint = document.createElement("div");
    shotsHint.className = "liuli-diag-hint";
    shotsHint.textContent = "设置页截图默认包含（不含聊天内容）；聊天窗口与壁纸缩略图只在勾选后采集。";
    block.appendChild(shotsHint);

    const actions = document.createElement("div");
    actions.className = "liuli-wp-actions";
    const exportBtn = llBtn("导出诊断包", "primary");
    const openBtn = llBtn("打开文件夹", "ghost");
    openBtn.disabled = true;
    actions.appendChild(exportBtn);
    actions.appendChild(openBtn);
    block.appendChild(actions);

    const status = document.createElement("div");
    status.className = "liuli-diag-status";
    status.textContent = "状态：就绪";
    block.appendChild(status);

    const errRow = document.createElement("div");
    errRow.className = "liuli-diag-errors";
    const errCount = document.createElement("span");
    errCount.textContent = "最近错误：0 条";
    const errToggle = document.createElement("button");
    errToggle.type = "button";
    errToggle.className = "liuli-diag-link";
    errToggle.textContent = "查看";
    errRow.appendChild(errCount);
    errRow.appendChild(errToggle);
    block.appendChild(errRow);

    const errList = document.createElement("div");
    errList.className = "liuli-diag-errlist";
    block.appendChild(errList);

    let lastPath = "";
    let busy = false;

    const setStatus = function (text, level) {
        status.textContent = "状态：" + text;
        status.classList.toggle("is-ok", level === "ok");
        status.classList.toggle("is-bad", level === "bad");
    };

    const renderErrorList = function () {
        errList.innerHTML = "";
        const list = getErrors().slice(-10).reverse();
        if (!list.length) {
            const empty = document.createElement("div");
            empty.className = "liuli-diag-err";
            empty.textContent = "本次启动没有捕获到错误。";
            errList.appendChild(empty);
            return;
        }
        list.forEach(function (e) {
            const item = document.createElement("div");
            item.className = "liuli-diag-err";
            const head = document.createElement("div");
            head.className = "liuli-diag-err__head";
            head.textContent = (e.t || "") + " · " + (e.level || "error") + " · " + (e.scope || "");
            const msg = document.createElement("div");
            msg.className = "liuli-diag-err__msg";
            msg.textContent = String(e.msg || "");
            item.appendChild(head);
            item.appendChild(msg);
            errList.appendChild(item);
        });
    };

    const refreshErrors = function () {
        errCount.textContent = "最近错误：" + getErrorCount() + " 条";
        if (errList.classList.contains("is-open")) renderErrorList();
    };
    refreshErrors();
    setInterval(refreshErrors, 3000);

    errToggle.addEventListener("click", function () {
        const open = errList.classList.toggle("is-open");
        errToggle.textContent = open ? "收起" : "查看";
        if (open) renderErrorList();
    });

    exportBtn.addEventListener("click", async function () {
        if (busy) return;
        busy = true;
        exportBtn.disabled = true;
        openBtn.disabled = true;
        const oldLabel = exportBtn.textContent;
        exportBtn.textContent = "正在收集…";
        setStatus("正在收集…");
        const started = Date.now();
        const opts = { screenshots: !!shots.checked };
        try {
            const snap = await collectDiagnostics({
                files: true, quota: true, wallpaperDecode: true, defaultWallpaper: true
            });
            const payload = buildExportPayload(opts, snap);
            const api = window.liuli_api;
            if (!api || typeof api.diagExport !== "function") {
                throw new Error("主进程接口不可用：window.liuli_api.diagExport 不存在（preload 未更新到 1.3.0）");
            }
            const res = await api.diagExport(payload);
            if (!res || !res.ok) throw new Error((res && res.error) || "主进程返回失败");
            lastPath = res.path || "";
            setStatus("已导出到 " + (lastPath || "(未返回路径)")
                + (res.copiedTo ? "，已复制到 " + res.copiedTo : "")
                + (res.size ? "（" + llFmtBytes(res.size) + "）" : ""), "ok");
            openBtn.disabled = !lastPath;
            toast("诊断包已导出：" + (lastPath || ""));
            auditWallpaper("diag-export", {
                ok: true, path: lastPath, copiedTo: res.copiedTo || "",
                size: Number(res.size) || 0, ms: Date.now() - started, screenshots: opts.screenshots
            });
        } catch (e) {
            const msg = llErrText(e);
            setStatus("失败：" + msg, "bad");
            toast("导出失败：" + msg);
            auditWallpaper("diag-export", {
                ok: false, error: msg, ms: Date.now() - started, screenshots: opts.screenshots
            });
        } finally {
            busy = false;
            exportBtn.disabled = false;
            exportBtn.textContent = oldLabel;
        }
    });

    openBtn.addEventListener("click", async function () {
        if (!lastPath) return;
        try {
            const api = window.liuli_api;
            if (!api || typeof api.diagOpenPath !== "function") {
                throw new Error("主进程接口不可用：window.liuli_api.diagOpenPath 不存在（preload 未更新到 1.3.0）");
            }
            const ok = await api.diagOpenPath(lastPath);
            if (!ok) throw new Error("系统没有打开该路径");
        } catch (e) {
            toast("打开文件夹失败：" + llErrText(e));
        }
    });
}

/* 「遮罩颜色」分段按钮（需求 A.4）：亮 | 暗，写进 veilLight / veilDark。
 * 值存在面板的 settings 对象上，和滑条一样走 saveSettings + applySettings 广播。 */
function buildVeilRow(veilKey, settings) {
    const row = document.createElement("div");
    row.className = "liuli-wp-fit liuli-mode-row liuli-veil-row";
    const label = document.createElement("span");
    label.textContent = "遮罩颜色";
    const seg = document.createElement("div");
    seg.className = "liuli-seg";
    row.appendChild(label);
    row.appendChild(seg);
    const btns = {};
    [["light", "亮"], ["dark", "暗"]].forEach(function (p) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "liuli-seg__item";
        b.textContent = p[1];
        b.addEventListener("click", function () {
            settings[veilKey] = p[0];
            saveSettings(settings);
            applySettings(settings);
            refresh();
        });
        seg.appendChild(b);
        btns[p[0]] = b;
    });
    function refresh() {
        const v = settings[veilKey] === "dark" ? "dark" : "light";
        Object.keys(btns).forEach(function (k) { btns[k].classList.toggle("is-active", k === v); });
    }
    refresh();
    // 别的窗口改了配置：跟随刷新选中项，并让面板的 settings 跟配置一致
    llVeilSegRefreshers.push(function (cfg) {
        const v = cfg && cfg[veilKey] === "dark" ? "dark" : "light";
        settings[veilKey] = v;
        refresh();
    });
    return row;
}

/* ════════════════════════════════════════════════════════════
 * 设置页顶部页签（需求 A）
 * ------------------------------------------------------------
 * 每个页签一个 div.liuli-tabpage，原有分组原样移进对应页；
 * 不显示的页只加 hidden（display: none），**不销毁 DOM**，原因：
 *   1. storage 同步按 document.querySelectorAll(".liuli-slider") 的下标取滑条，
 *      数量必须恒等于 FIELDS.length；
 *   2. 「遮罩颜色」分段按钮的刷新登记表 llVeilSegRefreshers 拿的是节点引用，
 *      节点一旦被移出文档就再也刷不到。
 * 选中的页签存 localStorage("liuli-settings-tab")，无效值回到第一页（外观）。
 * ════════════════════════════════════════════════════════════ */
const LL_TAB_KEY = "liuli-settings-tab";
const LL_TABS = [
    { key: "look", label: "外观" },
    { key: "wallpaper", label: "壁纸" },
    { key: "color", label: "配色" },
    { key: "layout", label: "布局" },
    { key: "text", label: "文字" },
    { key: "diag", label: "诊断" }
];

/* 上次打开的页签；不认识的值回到第一页（外观） */
function llSavedTab() {
    try {
        const v = localStorage.getItem(LL_TAB_KEY);
        return LL_TABS.some(function (t) { return t.key === v; }) ? v : LL_TABS[0].key;
    } catch (e) { return LL_TABS[0].key; }
}

/* 建页签栏 + 页容器，返回 { bar, pages, show }。
 * 嵌入页（#liuli-embedded）和任何另一个宿主（浮动面板）都走这一个函数：
 * container 是挂载点，groups 默认用 LL_TABS；pages 是 key → 容器，
 * 调用方把原有分组 append 进去即可。 */
function llBuildTabs(container, groups) {
    const list = (Array.isArray(groups) && groups.length) ? groups : LL_TABS;
    const bar = document.createElement("div");
    bar.className = "liuli-seg liuli-tabs";       // 复用 .liuli-seg / .liuli-seg__item 的分段按钮样式
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "琉璃设置分区");
    container.appendChild(bar);
    const btns = {};
    const pages = {};
    function show(key) {
        if (!pages[key]) key = list[0].key;
        Object.keys(pages).forEach(function (k) {
            const on = k === key;
            pages[k].classList.toggle("is-active", on);
            pages[k].hidden = !on;                 // 只隐藏，不销毁（见上面的原因）
        });
        Object.keys(btns).forEach(function (k) {
            const on = k === key;
            btns[k].classList.toggle("is-active", on);
            btns[k].setAttribute("aria-selected", on ? "true" : "false");
            btns[k].tabIndex = on ? 0 : -1;
        });
        try { localStorage.setItem(LL_TAB_KEY, key); } catch (e) {}
    }
    list.forEach(function (t) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "liuli-seg__item";
        b.textContent = t.label;
        b.dataset.tab = t.key;
        b.setAttribute("role", "tab");
        b.addEventListener("click", function () { show(t.key); });
        bar.appendChild(b);
        btns[t.key] = b;
    });
    list.forEach(function (t) {
        const p = document.createElement("div");
        p.className = "liuli-tabpage";
        p.dataset.tab = t.key;
        p.setAttribute("role", "tabpanel");
        p.hidden = true;
        container.appendChild(p);
        pages[t.key] = p;
    });
    show(llSavedTab());
    return { bar: bar, pages: pages, show: show };
}

function buildPanelContent(host, settings) {
    host.innerHTML = "";
    llVeilSegRefreshers = [];

    const head = document.createElement("div");
    head.className = "liuli-panel__head";
    head.innerHTML = '<div class="liuli-panel__title">琉璃</div>';
    host.appendChild(head);

    const sub = document.createElement("div");
    sub.className = "liuli-panel__sub";
    sub.textContent = "材质与外观 · 实时生效";
    host.appendChild(sub);

    /* 顶部页签（需求 A）：页签栏吸在设置区顶部，六个页各是一个 .liuli-tabpage 容器 */
    const tabs = llBuildTabs(host, LL_TABS);
    const pageLook = tabs.pages.look;
    const pageWp = tabs.pages.wallpaper;
    const pageColor = tabs.pages.color;
    const pageLayout = tabs.pages.layout;
    const pageText = tabs.pages.text;
    const pageDiag = tabs.pages.diag;

    const info = document.createElement("div");
    info.className = "liuli-info";
    const swatch = document.createElement("div");
    swatch.className = "liuli-swatch";
    const infoText = document.createElement("span");
    info.appendChild(swatch);
    info.appendChild(infoText);
    /* 取色信息条属于「配色」页：它显示的就是壁纸取色 → 品牌色这条链路的结果 */
    pageColor.appendChild(info);
    /* 「主题」分组：明暗模式（跟随 QQ / 亮色 / 暗色） */
    const themeGroup = document.createElement("div");
    themeGroup.className = "liuli-panel__group";
    themeGroup.textContent = "主题";
    pageLook.appendChild(themeGroup);
    buildModeControls(pageLook);
    const refreshInfo = () => {
        const src = document.body.dataset.liuliSource || DEFAULT_SOURCE;
        const brand = getComputedStyle(document.body).getPropertyValue("--ll-brand").trim();
        swatch.style.background = brand || src;
        infoText.textContent = "壁纸取色 " + src + " → 品牌 " + brand;
    };
    refreshInfo();
    setInterval(refreshInfo, 3000);

    const group = document.createElement("div");
    group.className = "liuli-panel__group";
    group.textContent = "材质";
    pageLook.appendChild(group);

    const inputs = {};
    for (const f of FIELDS) {
        const wrap = document.createElement("div");
        wrap.className = "liuli-field";
        const row = document.createElement("div");
        row.className = "liuli-field__row";
        const label = document.createElement("div");
        label.className = "liuli-field__label";
        label.textContent = f.label;
        const value = document.createElement("div");
        value.className = "liuli-field__value";
        row.appendChild(label);
        row.appendChild(value);
        wrap.appendChild(row);

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "liuli-slider";
        slider.min = f.min;
        slider.max = f.max;
        slider.step = f.step;
        slider.value = settings[f.key];
        wrap.appendChild(slider);

        const hint = document.createElement("div");
        hint.className = "liuli-field__hint";
        hint.textContent = f.hint;
        wrap.appendChild(hint);

        const sync = () => {
            const v = Number(slider.value);
            settings[f.key] = v;
            const pct = f.pct ? f.pct(v) : ((v - f.min) / (f.max - f.min)) * 100;
            slider.style.setProperty("--liuli-pct", Math.max(0, Math.min(100, pct)) + "%");
            value.textContent = f.key === "opacity" ? v.toFixed(2) : (f.unit ? v + f.unit : v.toFixed(2));
            applySettings(settings);
        };
        slider.addEventListener("input", sync);
        slider.addEventListener("change", () => saveSettings(settings));
        sync();
        inputs[f.key] = slider;
        // 「壁纸遮罩」两条各自带一个「遮罩颜色：亮 | 暗」分段按钮
        if (f.veilKey) wrap.appendChild(buildVeilRow(f.veilKey, settings));
        pageLook.appendChild(wrap);
    }

    buildBubbleToggles(pageLook, settings);

    // 两条遮罩共用的说明（需求 A.4 要求的提示文字）
    const veilNote = document.createElement("div");
    veilNote.className = "liuli-field__hint liuli-veil__note";
    veilNote.textContent = "遮罩颜色：「亮」盖一层白，「暗」盖一层黑。";
    pageLook.appendChild(veilNote);

    /* ── 其余各页：原有分组函数原样调用，只是容器从 host 换成对应页 ── */
    buildRoleControls(pageColor, function () { window.__liuliPaletteApplied = false; applyDynamicPalette(); });
    buildWallpaperControls(pageWp);      // 壁纸选择 / 裁剪适应 / 壁纸亮度提示
    buildLayoutSection(pageLayout);      // layout-custom.js 的全部分组
    const textGroup = document.createElement("div");
    textGroup.className = "liuli-panel__group";
    textGroup.textContent = "文字";
    pageText.appendChild(textGroup);
    buildMarkdownControls(pageText);
    buildFontControls(pageText);
    buildDiagSection(pageDiag);   // 契约 3.5：诊断小节放在「恢复默认」之前

    /* 「恢复默认」只把材质 / 遮罩打回默认值，放在外观页末尾 */
    const reset = document.createElement("div");
    reset.className = "liuli-field__hint";
    reset.style.cssText = "cursor:pointer;color:var(--ll-brand);margin-top:14px;";
    reset.textContent = "恢复默认";
    reset.addEventListener("click", () => {
        Object.assign(settings, DEFAULT_SETTINGS);
        for (const f of FIELDS) {
            inputs[f.key].value = settings[f.key];
            inputs[f.key].dispatchEvent(new Event("input"));
        }
        llRefreshVeilSegs(settings);   // 遮罩颜色也回到「亮 / 暗」
        saveSettings(settings);
        toast("已恢复默认");
    });
    pageLook.appendChild(reset);

    /* 「恢复全部默认」：连 localStorage 里的布局 / 明暗 / 壁纸 / 字体一起清，
     * 和上面只打回材质 / 遮罩的「恢复默认」区分开。不自动 reload，只提示重启。 */
    const resetAll = document.createElement("div");
    resetAll.className = "liuli-field__hint";
    resetAll.style.cssText = "cursor:pointer;color:var(--ll-brand);margin-top:8px;";
    resetAll.textContent = "恢复全部默认";
    resetAll.addEventListener("click", async () => {
        if (!confirm("恢复全部默认设置？包括布局、明暗、壁纸、字体等，需要重启 QQ 生效。")) return;
        const ok = await llResetAll();
        Object.assign(settings, DEFAULT_SETTINGS);
        for (const f of FIELDS) {
            inputs[f.key].value = settings[f.key];
            inputs[f.key].dispatchEvent(new Event("input"));
        }
        llRefreshVeilSegs(settings);   // 遮罩颜色也回到「亮 / 暗」
        toast(ok ? "已恢复全部默认，重启 QQ 生效" : "恢复失败，详见 plugin.log");
    });
    pageLook.appendChild(resetAll);
}

let embeddedSettings = null;
// 暴露重建入口：设置页窗口里的面板是加载时构建的，改了代码需要能热重建
window.__liuliRebuildPanel = function () {
    const box = document.getElementById("liuli-embedded");
    if (!box) return "no embedded panel";
    if (!embeddedSettings) embeddedSettings = loadSettingsSync();
    buildPanelContent(box, embeddedSettings);
    return "rebuilt";
};

/* 同步版：面板构建需要立即拿到配置（loadSettings 是 async） */
function loadSettingsSync() {
    const s = Object.assign({}, DEFAULT_SETTINGS);
    const raw = (window.__liuliSettingsCache || null);
    if (raw) Object.assign(s, raw);
    return s;
}
async function initPanel() {
    const settings = await loadSettings();
    window.__liuliSettingsCache = settings;
    applySettings(settings, true);
}

(async () => {
    /* 数据目录被整个删掉时（主进程 resetPending 返回 wipe=true）：
     * 先把 localStorage 里的 liuli 设置清干净、配置回默认，再走正常启动流程，
     * 这样这次启动呈现的就是默认样子。任何失败都只 warn，绝不挡启动。 */
    try {
        const api = window.liuli_api;
        if (api && typeof api.resetPending === "function") {
            const pending = await api.resetPending();
            if (pending && pending.wipe === true) {
                const ok = await llResetAll();
                /* 壁纸 revision 在模块顶部已经读过一次，先清掉这个内存值，免得被当成"没变化" */
                try { llWpRevSeen = ""; } catch (e) {}
                try { console.warn("[liuli-dsh-theme] data dir removed, local settings reset:", ok); } catch (e) {}
            }
        }
    } catch (e) {
        try { console.warn("[liuli-dsh-theme] reset check failed:", e && e.message); } catch (err) {}
    }

    const started = Date.now();
    installRouteScope();
    try {
        const chunks = [];
        for (const file of FILES) {
            // wallpaper.css 是可选的本地默认壁纸（不随仓库发布），没有就跳过
            try { chunks.push(await loadText(file)); }
            catch (e) { if (!OPTIONAL_FILES.has(file)) throw e; }
        }
        ensureStyle().textContent = chunks.join("\n");
        document.body.dataset.liuliTheme = "dsh";
        llApplyFont();

        // 静态色板先兜底，再按壁纸动态覆盖（失败时保持静态值）
        try {
            const m0 = llThemeMode();
            if (m0 !== "auto") document.body.dataset.liuliMode = m0;
            document.body.dataset.liuliDark = llIsDark() ? "1" : "0";
        } catch (e) {}
        try { await applyDynamicPalette(); }
        catch (e) { console.warn("[liuli-dsh-theme] dynamic palette failed:", e && e.message); }

        const bootWallpaper = loadWallpaperState();
        /* #37：启动时图片比例必然还没解码（用户日志 ratioKnown:false）。有选区时同步落笔
         * 会被 bgGeometry() 判成「算不出」而跳过；这里先发起解码，就绪后补一次渲染。
         * 坏图由 primeWallpaperRatioOnce() 记住只试一次，不会反复重试。 */
        if (bootWallpaper && bootWallpaper.src && bootWallpaper.area && !getImageRatio(bootWallpaper.src)) {
            primeWallpaperRatioOnce(bootWallpaper.src).then(function (r) {
                if (!r) return;
                renderWallpaper(loadWallpaperState(), "ratio-primed");
            });
        }
        renderWallpaper(bootWallpaper, "boot");
        // 启动兜底：有壁纸但 #app::before 没画出来 / 选区比例没就绪时再渲染一次（契约第四节第 4 条）
        if (bootWallpaper && bootWallpaper.src) scheduleWallpaperBootRetry();
        applyOverrides();
        fixContrast();
        normalizeColors();
        setInterval(liuliVisualPass, 1500);   // 兜底：正常情况下每条消息进 DOM 就即时跑过了
        try { installLayout(function () { llSyncPins(); }); } catch (e) { console.warn("[liuli-dsh-theme] layout failed:", e && e.message); }
        try { installArkExternal(window.liuli_api); } catch (e) { console.warn("[liuli-dsh-theme] ark external failed:", e && e.message); }
        installMarkdownObserver();
        installAvatarStick();
        ensureHoverEntries();
        installMessageObserver();
        liuliVisualPass();
        installSideListObserver();
        llWatchContactList();
        liuliMessagePass();
        try { await initPanel(); } catch (e) { console.warn("[liuli-dsh-theme] panel failed:", e && e.message); }
        console.log("[liuli-dsh-theme] ready in " + (Date.now() - started) + "ms");
        markBootReady();
    } catch (error) {
        const reason = (error && error.message) || String(error || "未知异常");
        console.error("[liuli-dsh-theme] inject failed:", reason);
        // 契约 S3：保留 failed 标记，并把异常消息交给 diag，快照 theme.failedReason 会带上
        try { document.body.dataset.liuliTheme = "failed"; } catch (e) {}
        try { noteThemeFailure(reason); } catch (e) {}
        markBootFailed(error);
    }
})();


/* ---------- 设置入口（LiteLoader 官方） ----------
 * LiteLoader 会在设置页左栏为每个插件加一项，点进去就是这个 view。
 */
export const onSettingWindowCreated = async view => {
    let cfg;
    try { cfg = await loadSettings(); } catch (e) { cfg = Object.assign({}, DEFAULT_SETTINGS); }
    window.__liuliSettingsCache = cfg;
    embeddedSettings = cfg;
    const box = document.createElement("div");
    box.id = "liuli-embedded";
    box.className = "liuli-embedded";
    try {
        view.appendChild(box);
        buildPanelContent(box, embeddedSettings);
        // 契约 S3：诊断快照要能证明"面板构建了但样式没生效"还是"面板压根没构建"
        try { notePanelBuild(true); } catch (e) {}
    } catch (error) {
        const reason = (error && error.message) || String(error || "未知异常");
        try { notePanelBuild(false, reason); } catch (e) {}
        try { console.error("[liuli-dsh-theme] settings panel build failed:", reason); } catch (e) {}
        throw error;
    }
};


/* ---------- Markdown 渲染（移植自 BetterQQNT 的 inlineMarkdown） ----------
 * 只认行内语法：`代码`、**粗体**、*斜体*、~~删除线~~、||剧透||，换行保留。
 * 先整体转义再替换，所以消息里的 < > & 不会变成标签。
 * 只处理聊天记录里的 .text-normal；原文存在 data-ll-md-src，关掉开关时原样还原。
 * 开关存 localStorage（设置窗口与主窗口同源，storage 事件实时同步）。
 */
const LL_MD_KEY = "liuli-md-render";
const LL_MD_TRIGGER = /`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|~~[^~\n]+~~|\|\|[^|\n]+\|\|/;

function llMdEnabled() {
    try { return localStorage.getItem(LL_MD_KEY) !== "0"; } catch (e) { return true; }
}

function llInlineMarkdown(md) {
    return md
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;")
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*\s][^*\n]*)\*/g, "<em>$1</em>")
        .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
        .replace(/\|\|([^|\n]+)\|\|/g, '<span class="ll-spoiler">$1</span>')
        .replace(/\n/g, "<br>");
}

function llMarkdownPass() {
    // 性能：滚动时这里会被频繁调用。只读 textContent（不触发排版），
    // 判过的元素在节点上记一个属性，文本没变就直接跳过。
    try {
        const on = llMdEnabled();
        const els = document.querySelectorAll(".ml-item .text-normal");
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            if (!on) {
                if (el.__llMdSrc !== undefined) {
                    el.textContent = el.__llMdSrc;
                    el.__llMdSrc = undefined;
                    el.__llMdSeen = undefined;
                    const box = el.closest(".message-content");
                    if (box) box.classList.remove("ll-inline-md");
                }
                continue;
            }
            const text = el.textContent;
            if (el.__llMdSeen === text) continue;          // 原文没变 / 渲染结果没被 Vue 改写
            if (!LL_MD_TRIGGER.test(text)) { el.__llMdSeen = text; el.__llMdSrc = undefined; continue; }
            el.__llMdSrc = text;
            el.innerHTML = llInlineMarkdown(text);
            el.__llMdSeen = el.textContent;
            const box = el.closest(".message-content");
            if (box) box.classList.add("ll-inline-md");
        }
    } catch (e) { /* 静默 */ }
}

/* ---------- 消息入场：级联 ----------
 * 只给两种情况做动画，滚动加载历史时不做（否则一滚就闪）：
 *   1. 刚切到一个会话：600ms 内出现的消息，从下往上依次浮入，每条错开 28ms，最多 14 条
 *   2. 新消息：加到列表最末尾的那条
 * 动画只用 opacity + transform，交给合成层，不触发排版。 */
let llEnterPeer = "";
let llEnterUntil = 0;
const LL_ENTER_MAX = 14;

function llCurrentPeer() {
    const rec = llMsgRecordOf(document.querySelector(".chat-msg-area .message"));
    return rec ? String(rec.peerUid) : "";
}

function llAnimateEnter(items) {
    if (!items.length || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // 越靠下（越新）越先出来
    items.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    items.slice(0, LL_ENTER_MAX).forEach((el, i) => {
        el.style.setProperty("--ll-enter-i", String(i));
        el.classList.remove("ll-enter");
        void el.offsetWidth;
        el.classList.add("ll-enter");
        clearTimeout(el.__llEnterT);
        el.__llEnterT = setTimeout(() => el.classList.remove("ll-enter"), 400 + i * 28);
    });
}

function llHandleAdded(records) {
    const added = [];
    for (const r of records) {
        for (const n of r.addedNodes) {
            if (n.nodeType === 1 && n.classList.contains("ml-item")) added.push(n);
        }
    }
    if (!added.length) return;
    const now = Date.now();
    const peer = llCurrentPeer();
    if (peer && peer !== llEnterPeer) { llEnterPeer = peer; llEnterUntil = now + 600; }
    if (now < llEnterUntil) { llAnimateEnter(added); return; }
    // 新消息：节点是列表里最后一条
    const fresh = added.filter(n => !n.nextElementSibling);
    if (fresh.length) llAnimateEnter(fresh);
}

function installMarkdownObserver() {
    if (window.__llMdObserver) return;
    // 性能：DOM 变动后 150ms 才跑一次（滚动期间合并成一次），不再每帧跑
    let queued = false;
    const run = () => { llMarkdownPass(); llAtPass(); };
    window.__llMdObserver = new MutationObserver(records => {
        try { llHandleAdded(records); } catch (e) {}
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; run(); });
    });
    window.__llMdObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("storage", e => { if (e.key === LL_MD_KEY) llMarkdownPass(); });
    run();
}

/* 「气泡背景」两个开关：透明 / 模糊。模糊直接复用「材质模糊」那一项的 --ll-material-blur */
function buildBubbleToggles(host, snapshot) {
    const make = function (key, label, opts) {
        const row = document.createElement("div");
        row.className = "liuli-wp-fit liuli-mode-row";
        const lab = document.createElement("span");
        lab.textContent = label;
        const seg = document.createElement("div");
        seg.className = "liuli-seg";
        row.appendChild(lab);
        row.appendChild(seg);
        host.appendChild(row);
        const btns = [];
        opts.forEach(function (o) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "liuli-seg__item";
            b.textContent = o.text;
            b.addEventListener("click", function () {
                llModeCfg[key] = o.value;
                if (snapshot) snapshot[key] = o.value;   // 面板快照也同步，滑条再触发 applySettings 时不会被冲掉
                applySettings(llModeCfg);
                saveSettings(llModeCfg);
                refresh();
            });
            seg.appendChild(b);
            btns.push([o.value, b]);
        });
        function refresh() {
            const cur = !!(llModeCfg || DEFAULT_SETTINGS)[key];
            btns.forEach(function (pair) { pair[1].classList.toggle("is-active", pair[0] === cur); });
        }
        refresh();
        llVeilSegRefreshers.push(refresh);
    };
    make("bubbleClear", "气泡背景", [{ text: "有底色", value: false }, { text: "透明", value: true }]);
    make("bubbleBlur", "气泡模糊", [{ text: "关闭", value: false }, { text: "开启", value: true }]);
}

function buildMarkdownControls(host) {
    const row = document.createElement("div");
    row.className = "liuli-wp-fit liuli-mode-row";
    const label = document.createElement("span");
    label.textContent = "Markdown 渲染";
    const seg = document.createElement("div");
    seg.className = "liuli-seg";
    row.appendChild(label);
    row.appendChild(seg);
    host.appendChild(row);
    const btns = {};
    [["1", "开启"], ["0", "关闭"]].forEach(function (p) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "liuli-seg__item";
        b.textContent = p[1];
        b.addEventListener("click", function () {
            try { localStorage.setItem(LL_MD_KEY, p[0]); } catch (err) {}
            llMarkdownPass();
            refresh();
        });
        seg.appendChild(b);
        btns[p[0]] = b;
    });
    function refresh() {
        const cur = llMdEnabled() ? "1" : "0";
        Object.keys(btns).forEach(function (k) { btns[k].classList.toggle("is-active", k === cur); });
    }
    refresh();
}


/* ---------- 读消息数据 ----------
 * QQ 9.9.36 在 .message 元素上挂了 __VUE__（组件实例数组），props.msgRecord 就是这条消息。
 * 实测见 probe/ll-probe。 */
function llMsgRecordOf(el) {
    try {
        const m = el && el.closest && el.closest(".message");
        const inst = m && m.__VUE__ && m.__VUE__[0];
        return (inst && inst.props && inst.props.msgRecord) || null;
    } catch (e) { return null; }
}

/* ---------- @ 高亮：@我 与 @别人 分两种颜色 ----------
 * 每个 @ 是 .text-element[data-element-id] > .text-element--at，
 * 用 elementId 在 msgRecord.elements 里找到对应元素，比对 atNtUid 与自己的 uid。
 * atType 1 是 @全体成员，算作 @我。 */
let llSelfUid = "";
function llLoadSelfUid() {
    if (llSelfUid || !window.liuli_api) return;
    window.liuli_api.selfUid().then(uid => { if (uid) { llSelfUid = String(uid); llAtPass(); } }).catch(() => {});
}

function llAtPass() {
    try {
        if (!llSelfUid) { llLoadSelfUid(); return; }
        const ats = document.querySelectorAll(".ml-item .text-element--at");
        for (let i = 0; i < ats.length; i++) {
            const at = ats[i];
            const holder = at.closest("[data-element-id]");
            if (!holder) continue;
            const id = holder.getAttribute("data-element-id");
            if (at.dataset.llAtId === id) continue;   // 已判过（节点被复用时 id 会变）
            const rec = llMsgRecordOf(at);
            if (!rec || !Array.isArray(rec.elements)) continue;
            const el = rec.elements.find(e => String(e.elementId) === id);
            const te = el && el.textElement;
            if (!te) continue;
            const me = te.atType === 1 || (te.atNtUid && String(te.atNtUid) === llSelfUid);
            at.dataset.llAt = me ? "me" : "other";
            at.dataset.llAtId = id;
        }
    } catch (e) { /* 静默 */ }
}


/* ---------- 字体 ----------
 * 设置页里选一个本机已安装的字体，整个 QQ 界面换成它（代码块仍用等宽字体）。
 * 存 localStorage（设置窗口与主窗口同源，storage 事件实时同步）；空 = 默认 MiSans。
 * 候选列表：先试 Chromium 的 queryLocalFonts（要权限，QQ 可能不给），
 * 不给就用常见中文字体名单，靠 canvas 量宽度判断本机装没装。 */
const LL_FONT_KEY = "liuli-font";
const LL_FONT_CANDIDATES = [
    "MiSans", "HarmonyOS Sans SC", "OPPOSans", "vivo Sans", "Alibaba PuHuiTi 3.0", "阿里巴巴普惠体 3.0",
    "LXGW WenKai", "霞鹜文楷", "LXGW WenKai Screen", "霞鹜文楷 屏幕阅读版",
    "Source Han Sans SC", "思源黑体", "Noto Sans SC", "Noto Sans CJK SC", "Sarasa UI SC", "更纱黑体 UI SC",
    "Microsoft YaHei UI", "Microsoft YaHei", "微软雅黑", "DengXian", "等线", "PingFang SC",
    "Inter", "Segoe UI", "SimHei", "黑体", "KaiTi", "楷体", "SimSun", "宋体", "FangSong", "仿宋",
];

function llFontName() {
    try { return (localStorage.getItem(LL_FONT_KEY) || "").trim(); } catch (e) { return ""; }
}

// 只留字体名里正常的字符，防止拼进 CSS 时出问题
function llCleanFont(name) {
    return String(name || "").replace(/["'\\;{}<>]/g, "").trim().slice(0, 64);
}

function llApplyFont() {
    const name = llCleanFont(llFontName());
    const b = document.body;
    if (!b) return;
    if (!name) {
        b.style.removeProperty("--ll-font");
        delete b.dataset.llFont;
        return;
    }
    b.style.setProperty("--ll-font", '"' + name + '", "MiSans", "Microsoft YaHei UI", system-ui, sans-serif, "Segoe UI Emoji"');
    b.dataset.llFont = "1";
}
window.addEventListener("storage", e => { if (e.key === LL_FONT_KEY) llApplyFont(); });

let llFontCtx = null;
function llFontInstalled(name) {
    try {
        if (!llFontCtx) llFontCtx = document.createElement("canvas").getContext("2d");
        const sample = "永和九年岁在癸丑 Hamburgefonstiv 0123";
        for (const base of ["monospace", "serif"]) {
            llFontCtx.font = "32px " + base;
            const w0 = llFontCtx.measureText(sample).width;
            llFontCtx.font = '32px "' + name + '", ' + base;
            if (llFontCtx.measureText(sample).width !== w0) return true;
        }
    } catch (e) {}
    return false;
}

async function llListFonts() {
    try {
        if (window.queryLocalFonts) {
            const fonts = await window.queryLocalFonts();
            const names = Array.from(new Set(fonts.map(f => f.family))).sort((a, b) => a.localeCompare(b, "zh"));
            if (names.length) return names;
        }
    } catch (e) { /* 没权限，退回名单 */ }
    return LL_FONT_CANDIDATES.filter(llFontInstalled);
}

function buildFontControls(host) {
    const row = document.createElement("div");
    row.className = "liuli-wp-fit liuli-mode-row";
    const label = document.createElement("span");
    label.textContent = "字体";
    const box = document.createElement("div");
    box.style.cssText = "display:flex;gap:6px;align-items:center;flex:1;justify-content:flex-end;";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "默认（MiSans）";
    input.value = llFontName();
    input.setAttribute("list", "liuli-font-list");
    input.style.cssText = "width:180px;height:28px;padding:0 10px;border-radius:8px;border:none;outline:none;" +
        "background:rgba(var(--ll-on-glass-rgb),0.08);color:var(--ll-on-glass);font:inherit;font-size:13px;";
    const list = document.createElement("datalist");
    list.id = "liuli-font-list";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "liuli-seg__item";
    reset.textContent = "默认";
    box.appendChild(input);
    box.appendChild(list);
    box.appendChild(reset);
    row.appendChild(label);
    row.appendChild(box);
    host.appendChild(row);

    const apply = name => {
        name = llCleanFont(name);
        try {
            if (name) localStorage.setItem(LL_FONT_KEY, name);
            else localStorage.removeItem(LL_FONT_KEY);
        } catch (e) {}
        input.value = name;
        llApplyFont();
    };
    input.addEventListener("change", () => apply(input.value));
    input.addEventListener("keydown", e => { if (e.key === "Enter") apply(input.value); });
    reset.addEventListener("click", () => apply(""));

    llListFonts().then(names => {
        list.innerHTML = "";
        for (const n of names) {
            const o = document.createElement("option");
            o.value = n;
            list.appendChild(o);
        }
        input.title = names.length ? "本机可用 " + names.length + " 种，点输入框可选" : "直接输入字体名";
    });
}
