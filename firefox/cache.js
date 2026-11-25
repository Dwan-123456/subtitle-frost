// Mirror the clear fragmented-MP4 video segments already submitted to this page's
// MediaSource. No downloads, disk-cache inspection, audio, or license requests.
(() => {
    if (!window.MediaSource || !window.SourceBuffer) return;
    const sources = new Map(), tracks = new WeakMap(), streams = new WeakMap();
    const LIMIT = 32 * 1024 * 1024;
    const createURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
        const url = createURL.call(this, obj);
        if (obj instanceof MediaSource) {
            if (sources.size >= 16) sources.delete(sources.keys().next().value);
            sources.set(url, new WeakRef(obj));
        }
        return url;
    };
    const addBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (type) {
        const buffer = addBuffer.call(this, type);
        if (/^video\/mp4/i.test(type)) {
            const track = {type, init:null, recent:[], bytes:0, push:null};
            tracks.set(buffer,track); streams.set(this,track);
        }
        return buffer;
    };
    const append = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (input) {
        const result = append.call(this,input);
        const t = tracks.get(this);
        if (!t) return result;
        try {
            const bytes = ArrayBuffer.isView(input)
                ? new Uint8Array(input.buffer,input.byteOffset,input.byteLength) : new Uint8Array(input);
            if (bytes.byteLength>LIMIT || bytes.length<8) return result;
            const type=String.fromCharCode(...bytes.subarray(4,8));
            if (type==="ftyp" || type==="moov") {
                if(t.push) close();
                t.init={data:bytes.slice(),offset:this.timestampOffset};
                t.recent=[];t.bytes=0;
            } else if(t.init) {
                const packet={data:bytes.slice(),offset:this.timestampOffset};
                t.recent.push(packet);t.bytes+=bytes.length;
                while(t.bytes>LIMIT) t.bytes-=t.recent.shift().data.length;
                t.push?.(packet);
            }
        } catch { /* Preview failures must never interrupt the movie. */ }
        return result;
    };
    let dispose;
    function close(){if(dispose){const fn=dispose;dispose=null;fn();}}
    document.addEventListener("subtitle-blur-cache-stop",close);
    document.addEventListener("subtitle-blur-cache-start",() => {
        close();
        const movie=document.querySelector("video[data-subtitle-blur-selected]");
        if(!movie || movie.mediaKeys)return;
        const original=sources.get(movie.currentSrc)?.deref();
        const t=original && streams.get(original);
        if(!t?.init)return;
        const preview=document.createElement("video");
        preview.dataset.subtitleBlurPreview="1";
        preview.muted=true;preview.preload="auto";preview.playsInline=true;
        preview.style.cssText="display:none!important";
        const media=new MediaSource(),url=createURL.call(URL,media);
        const queue=[t.init,...t.recent];
        let buffer, active=true;
        function pump(){
            if(!active || !buffer || buffer.updating || !queue.length)return;
            try {
                const ranges=buffer.buffered;
                if(ranges.length && ranges.start(0)<movie.currentTime-12) {
                    buffer.remove(ranges.start(0),movie.currentTime-6);return;
                }
                const packet=queue.shift();
                buffer.timestampOffset=packet.offset;
                buffer.appendBuffer(packet.data);
            } catch {close();}
        }
        t.push=packet=>{
            if(queue.reduce((n,p)=>n+p.data.byteLength,0)+packet.data.byteLength>LIMIT*2){close();return;}
            queue.push(packet);pump();
        };
        dispose=()=>{active=false;t.push=null;queue.length=0;preview.removeAttribute("src");
            preview.load();preview.remove();URL.revokeObjectURL(url);};
        media.addEventListener("sourceopen",()=>{
            if(!active)return;
            try {
                buffer=addBuffer.call(media,t.type); // Never mirror the preview itself.
                buffer.addEventListener("updateend",pump);
                buffer.addEventListener("error",()=>{if(active)close();});
                pump();
            }catch{close();}
        },{once:true});
        document.documentElement.append(preview);preview.src=url;
    });
})();
