// 琉璃主题插件 · 透明图片不画气泡底板
// 采样图片的 alpha：整张图有足够多透明像素时，给它的气泡打 data-liuli-alpha="1"，
// 由 bubbles.css 把气泡背景和内边距去掉，只留图片本身（表情包、贴纸用）。

const MARK = "data-liuli-alpha";
const CACHE = new Map();      // src -> true / false
const PENDING = new Map();    // src -> Promise
const PIC_BUBBLE = "mix-message__container--pic mix-message__container--image";
let logged = 0;

function log(line) {
    if (logged++ > 6) return;
    try { console.warn("[liuli-alpha] " + line); } catch (e) { }
}

/* 画到 64×64 画布上数透明像素；图片跨源取不到像素时抛错，交给头部嗅探 */
function sampleAlpha(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = function () {
            try {
                const w = Math.min(64, img.naturalWidth || 64);
                const h = Math.min(64, img.naturalHeight || 64);
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                const ctx = c.getContext("2d", { willReadFrequently: true });
                ctx.clearRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);
                const px = ctx.getImageData(0, 0, w, h).data;
                let clear = 0;
                for (let i = 3; i < px.length; i += 4) if (px[i] < 250) clear++;
                const ratio = clear / (w * h);
                log("canvas " + (ratio > 0.15 ? "透明" : "不透明") + " ratio=" + ratio.toFixed(2) + " " + src.slice(0, 24));
                resolve(ratio > 0.15);
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = reject;
        img.src = src;
    });
}

/* 取不到像素时按文件头判断有没有 alpha 通道（PNG / WebP） */
async function sniffAlpha(src) {
    const res = await fetch(src);
    if (!res.ok) throw new Error("fetch " + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    const head = [];
    for (let i = 0; i < Math.min(buf.length, 40); i++) head.push(String.fromCharCode(buf[i]));
    const sig = head.join("");
    if (sig.indexOf("\x89PNG") === 0) {
        const colorType = buf[25];
        const hasAlpha = colorType === 4 || colorType === 6 || sig.indexOf("tRNS") >= 0;
        log("png header alpha=" + hasAlpha);
        return hasAlpha;
    }
    if (sig.indexOf("RIFF") === 0 && sig.indexOf("WEBP") > 0) {
        const hasAlpha = sig.indexOf("VP8L") > 0 ? true : sig.indexOf("VP8X") > 0 ? (buf[20] & 0x10) !== 0 : false;
        log("webp header alpha=" + hasAlpha);
        return hasAlpha;
    }
    log("其它格式按不透明处理");
    return false;
}

function isTransparent(src) {
    if (CACHE.has(src)) return Promise.resolve(CACHE.get(src));
    if (PENDING.has(src)) return PENDING.get(src);
    const task = sampleAlpha(src)
        .catch(() => sniffAlpha(src))
        .catch(e => { log("判定失败 " + (e && e.message)); return false; })
        .then(v => {
            CACHE.set(src, v);
            PENDING.delete(src);
            return v;
        });
    PENDING.set(src, task);
    return task;
}

function markBubble(img) {
    const bubble = img.closest(".msg-content-container");
    if (bubble) bubble.setAttribute(MARK, "1");
}

export function installTransparentImages() {
    try {
        const imgs = document.querySelectorAll(".msg-content-container img");
        for (const img of imgs) {
            const bubble = img.closest(".msg-content-container");
            if (!bubble) continue;
            // 只处理纯图片消息：卡片、图文混排、文字气泡里的行内表情都不动
            if (!bubble.className.split(" ").some(c => PIC_BUBBLE.indexOf(c) >= 0)) continue;
            if (bubble.querySelectorAll("img").length !== 1) continue;
            const src = img.currentSrc || img.src;
            if (!src) continue;
            if (CACHE.has(src)) {
                if (CACHE.get(src)) markBubble(img);
                continue;
            }
            isTransparent(src).then(v => { if (v) markBubble(img); });
        }
    } catch (e) { }
}
