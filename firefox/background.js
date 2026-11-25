browser.browserAction.onClicked.addListener(tab => activate(tab, "select"));
browser.commands.onCommand.addListener(async command => {
    if (command === "reselect" || command === "stats") {
        const [tab] = await browser.tabs.query({active:true,currentWindow:true});
        if (tab) await activate(tab, command);
    }
});
async function activate(tab, type) {
    try {
        connection(); // Start the model while the user draws the region.
        await browser.tabs.executeScript(tab.id, {file: "video.js"});
        await browser.tabs.sendMessage(tab.id, {type});
    } catch (error) {
        console.warn("无法访问当前页面", error);
        await browser.browserAction.setBadgeText({tabId: tab.id, text: "!"});
    }
}
browser.runtime.onMessage.addListener((msg, sender) => {
    if (!sender.tab || msg.type !== "ocr") return;
    return recognize(msg.image);
});
async function recognize(data) {
    const port = connection();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {
            pending.delete(id);
            reject(Error("本机模型超时，将重新连接"));
            if(port===nativePort)port.disconnect();
            if(port===nativePort){nativePort=null;for(const job of pending.values())job.reject(Error("模型已重连"));pending.clear();}
        }, 8000);
        pending.set(id, {
            resolve(value){clearTimeout(deadline);resolve(value);},
            reject(error){clearTimeout(deadline);reject(error);}
        });
        try { port.postMessage({id, image:data}); }
        catch (error) { clearTimeout(deadline);pending.delete(id);reject(error); }
    });
}
let nativePort, idle, sequence = 0;
const pending = new Map();
function armIdle() {
    clearTimeout(idle);
    idle = setTimeout(() => {
        if (!pending.size && nativePort) {
            const port = nativePort;
            nativePort = null;
            port.disconnect();
        }
    }, 60000);
}
function connection() {
    armIdle();
    if (nativePort) return nativePort;
    const port = browser.runtime.connectNative("local.subtitle_blur");
    nativePort = port;
    port.onMessage.addListener(reply => {
        const job = pending.get(reply.id);
        if (!job) return;
        pending.delete(reply.id);
        if (reply.error) job.reject(Error(reply.error));
        else job.resolve({chinese:reply.boxes,english:reply.english || [],perf:reply.perf});
        armIdle();
    });
    port.onDisconnect.addListener(() => {
        if (port !== nativePort) return;
        nativePort = null;
        const error = Error(port.error?.message || "本机识别进程已退出");
        for (const job of pending.values()) job.reject(error);
        pending.clear();
    });
    return port;
}
