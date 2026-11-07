// 琉璃主题插件 · 透明图片不画气泡底板
// 图片一进 DOM 就先按「无底板」渲染（data-liuli-alpha="pending"），采样确认不透明后再把底板补回来，
// 这样透明图（表情包、贴纸）不会先闪一下气泡。alpha 用画布采样，取不到像素时读 PNG/WebP 文件头。

const MARK = "data-liuli-alpha";
const CACHE = new Map();      // src -> true / false
const PENDING = new Map();    // src -> Promise
const PIC_CLASSES = ["mix-message__container--pic", "mix-message__container--image"];
let logged = 0;
let observer = null;
let queued = false;

function log(line) {
    if (logged++ > 4) return;
    try { console.warn("[liuli-alpha] " + line); } catch (e) { }
}

/* 画到 64×64 画布上数透明像素；跨源取不到像素时抛错，交给头部嗅探 */
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
                log("canvas ratio=" + ratio.toFixed(2));
                resolve(ratio > 0.15);
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = reject;
        img.src = src;
    });
}

/* 取不到像素时按文件头判断有没有 alpha 通道 */
async function sniffAlpha(src) {
    const res = await fetch(src);
    if (!res.ok) throw new Error("fetch " + res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    let sig = "";
    for (let i = 0; i < Math.min(buf.length, 40); i++) sig += String.fromCharCode(buf[i]);
    if (sig.indexOf("\x89PNG") === 0) {
        const hasAlpha = buf[25] === 4 || buf[25] === 6 || sig.indexOf("tRNS") >= 0;
        log("png header alpha=" + hasAlpha);
        return hasAlpha;
    }
    if (sig.indexOf("RIFF") === 0 && sig.indexOf("WEBP") > 0) {
        const hasAlpha = sig.indexOf("VP8L") > 0 ? true : sig.indexOf("VP8X") > 0 ? (buf[20] & 0x10) !== 0 : false;
        log("webp header alpha=" + hasAlpha);
        return hasAlpha;
    }
    return false;
}

function isTransparent(src) {
    if (CACHE.has(src)) return Promise.resolve(CACHE.get(src));
    if (PENDING.has(src)) return PENDING.get(src);
    const task = sampleAlpha(src)
        .catch(() => sniffAlpha(src))
        .catch(() => false)
        .then(v => {
            CACHE.set(src, v);
            PENDING.delete(src);
            return v;
        });
    PENDING.set(src, task);
    return task;
}

function isPicBubble(bubble) {
    const cls = (bubble.className || "").split(" ");
    for (const c of PIC_CLASSES) if (cls.indexOf(c) >= 0) return true;
    return false;
}

/* 只处理纯图片消息：卡片、图文混排、文字气泡里的行内表情一律不动。
 * 小程序 / 转发卡片也可能带 --pic 类，它们的底板不能去掉（去掉就和壁纸糊在一起）。 */
function bubbleOf(img) {
    const bubble = img.closest(".msg-content-container");
    if (!bubble || !isPicBubble(bubble)) return null;
    if (bubble.classList.contains("ark-msg-content-container")) return null;
    if (bubble.querySelector(".ark-view-message, .forward-msg")) return null;
    if (bubble.querySelectorAll("img").length !== 1) return null;
    return bubble;
}

function decide(img) {
    const bubble = bubbleOf(img);
    if (!bubble) return;
    const src = img.currentSrc || img.src;
    if (!src) return;
    if (CACHE.has(src)) {
        bubble.setAttribute(MARK, CACHE.get(src) ? "1" : "0");
        return;
    }
    bubble.setAttribute(MARK, "pending");
    isTransparent(src).then(v => {
        if (bubbleOf(img) !== bubble) return;
        bubble.setAttribute(MARK, v ? "1" : "0");
    });
}

function scan() {
    queued = false;
    try {
        const imgs = document.querySelectorAll(".msg-content-container img");
        for (const img of imgs) {
            const bubble = bubbleOf(img);
            if (!bubble) continue;
            if (!bubble.hasAttribute(MARK)) bubble.setAttribute(MARK, "pending");
            if (img.__liuliAlphaDone) continue;
            if (img.complete && img.naturalWidth) {
                img.__liuliAlphaDone = true;
                decide(img);
            } else if (!img.__liuliAlphaWatched) {
                img.__liuliAlphaWatched = true;
                img.addEventListener("load", function () {
                    img.__liuliAlphaDone = true;
                    decide(img);
                }, { once: true });
            }
        }
    } catch (e) { }
}

function queueScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(scan);
}

export function installTransparentImages() {
    if (!observer) {
        // 只关心「新插入的图片 / 消息容器」，别被聊天列表的滚动变更牵着走
        observer = new MutationObserver(function (muts) {
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    if (n.tagName === "IMG" || (n.querySelector && n.querySelector("img, .msg-content-container")) || (n.classList && n.classList.contains("msg-content-container"))) {
                        queueScan();
                        return;
                    }
                }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    queueScan();
}
