(() => {
    if (globalThis.subtitleBlurActiveListener) return;
    globalThis.subtitleBlurActiveListener = true;
    let stop = null,starting=false, toggleStats=null;
    const regionKey="subtitle-region:"+location.hostname;
    browser.runtime.onMessage.addListener(async message => {
        if(message.type==="stats"){if(toggleStats)toggleStats();else notify("请先启动字幕识别。");return;}
        if (!["select","reselect"].includes(message.type) || starting) return;
        if (stop) { stop(); if(message.type==="select")return; }
        starting=true;
        try{
            const videos=[...document.querySelectorAll("video:not([data-subtitle-blur-preview])")]
                .filter(v=>v.videoWidth && v.clientWidth);
            const v=videos.sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0];
            if(!v){notify("请先播放视频，再点击扩展。");return;}
            if(message.type==="reselect"){selectRegion(v);return;}
            const saved=(await browser.storage.local.get(regionKey))[regionKey];
            track(v,saved || defaultRegion(v));
        }finally{starting=false;}
    });
    function defaultRegion(v){
        // Exact crop in the supplied 3839 x 2159 fullscreen screenshot.
        const scale=Math.min(3839/v.videoWidth,2159/v.videoHeight);
        const w=scale*v.videoWidth,h=scale*v.videoHeight;
        const clamp=n=>Math.max(0,Math.min(1,n));
        const x=clamp((2-(3839-w)/2)/w),y=clamp((1465-(2159-h)/2)/h);
        return {x,y,w:clamp((3839-(3839-w)/2)/w)-x,h:clamp((1980-(2159-h)/2)/h)-y};
    }
    function host() { return document.fullscreenElement || document.documentElement; }
    function layer(style) {
        const element = document.createElement("div");
        element.style.cssText = "all:initial;position:fixed;z-index:2147483647;pointer-events:none;" + style;
        host().appendChild(element);
        return element;
    }
    function notify(text) {
        const note = layer("top:16px;left:16px;padding:10px;color:white;background:#222;font:15px sans-serif");
        note.textContent = text;
        setTimeout(() => note.remove(), 4500);
    }
    function videoRect(v) {
        const r = v.getBoundingClientRect();
        const fill = getComputedStyle(v).objectFit;
        let w = r.width, h = r.height;
        // Bilibili normally centers the image and retains its aspect ratio.
        if (fill !== "fill" && v.videoWidth && v.videoHeight) {
            const scale = (fill === "cover" ? Math.max : Math.min)(w/v.videoWidth,h/v.videoHeight);
            w = v.videoWidth*scale; h = v.videoHeight*scale;
        }
        return {x:r.x+(r.width-w)/2,y:r.y+(r.height-h)/2,w,h};
    }
    function place(el,x,y,w,h) {
        Object.assign(el.style,{left:x+"px",top:y+"px",width:w+"px",height:h+"px"});
    }
    function selectRegion(v) {
        const surface = layer("inset:0;pointer-events:auto;cursor:crosshair;background:#0002;touch-action:none");
        const border = layer("border:2px solid #50e6b0");
        notify("拖框选中字幕可能出现的范围（可以包含中英文），Esc 取消。");
        let start;
        const point = e => {
            const r = videoRect(v);
            return [Math.max(0,Math.min(1,(e.clientX-r.x)/r.w)),Math.max(0,Math.min(1,(e.clientY-r.y)/r.h))];
        };
        const cancel = e => {if(e.key==="Escape") stop?.();};
        stop = () => {surface.remove();border.remove();window.removeEventListener("keydown",cancel,true);stop=null;};
        window.addEventListener("keydown",cancel,true);
        surface.onpointerdown = e => {start=point(e);surface.setPointerCapture(e.pointerId);};
        function region(e) {
            const end=point(e);
            return {x:Math.min(start[0],end[0]),y:Math.min(start[1],end[1]),
                w:Math.abs(start[0]-end[0]),h:Math.abs(start[1]-end[1])};
        }
        surface.onpointermove = e => {
            if (!start) return;
            const a=region(e),r=videoRect(v);
            place(border,r.x+a.x*r.w,r.y+a.y*r.h,a.w*r.w,a.h*r.h);
        };
        surface.onpointerup = e => {
            if(!start) return;
            const a=region(e); stop();
            if(a.w*v.videoWidth<20 || a.h*v.videoHeight<10) return;
            browser.storage.local.set({[regionKey]:a}).catch(()=>notify("选区已生效，但保存失败。"));
            track(v,a);
        };
    }
    // Local bright-edge signatures distinguish subtitle glyphs from a flat background.
    // Compare only the box recognized as Chinese, never the neighboring English line.
    function signature(frame,box) {
        const keys=[];
        const {data,width,height}=frame;
        for(let y=Math.max(1,box[1]);y<Math.min(height-1,box[3]);y+=2) {
            for(let x=Math.max(1,box[0]);x<Math.min(width-1,box[2]);x+=2) {
                const i=(y*width+x)*4;
                const contrast=Math.max(Math.abs(data[i]-data[i-4]),Math.abs(data[i]-data[i-width*4]));
                if(contrast>42) keys.push(i);
            }
        }
        return keys;
    }
    function stillVisible(oldFrame,now,keys) {
        if(!keys.length) return false;
        let match=0;
        for(const i of keys) {
            const neighbor=Math.abs(oldFrame.data[i]-oldFrame.data[i-4])>42 ? i-4 : i-now.width*4;
            const before=oldFrame.data[i]-oldFrame.data[neighbor];
            if(Math.sign(before)*(now.data[i]-now.data[neighbor])>22) match++;
        }
        return match/keys.length>=0.56;
    }
    function retainMask(mask, visible, mediaTime, now){
        if(visible){
            mask.lastHit=now; mask.misses=0; mask.checkedTime=mediaTime;
        }else if(mask.checkedTime!==mediaTime){
            mask.misses++; mask.checkedTime=mediaTime;
        }
        return mask.misses<2 || now-mask.lastHit<20;
    }
    function track(v,a) {
        const canvas=document.createElement("canvas");
        const ctx=canvas.getContext("2d",{willReadFrequently:true});
        const scale=Math.min(1,960/(a.w*v.videoWidth),360/(a.h*v.videoHeight));
        canvas.width=Math.max(1,Math.round(a.w*v.videoWidth*scale));
        canvas.height=Math.max(1,Math.round(a.h*v.videoHeight*scale));
        const aheadCanvas=canvas.cloneNode();
        const aheadCtx=aheadCanvas.getContext("2d",{willReadFrequently:true});
        // Sample only the selected ROI. The preview decoder has its own playhead.
        const horizon=1.5;
        let previousTime=null,previousPresented=null,frameDuration=1/24;
        const frameIntervals=[];
        let ticks=0,requests=0,rateStart=performance.now(),rateText="";
        let statsPanel=null,perf=null, timings=[],cachedFrames=0,totalFrames=0;
        toggleStats=()=>{
            if(statsPanel){statsPanel.remove();statsPanel=null;return;}
            statsPanel=layer("top:12px;right:12px;background:#15171be8;color:white;padding:8px;font:13px sans-serif");
            updateStats();
        };
        function updateStats(){
            const now=performance.now();
            if(now-rateStart>=1000){
                const seconds=(now-rateStart)/1000;
                rateText="片源 "+(frameIntervals.length?(1/frameDuration).toFixed(1):"–")+" fps · "+
                    (ticks/seconds).toFixed(0)+" 次检查/s · "+(requests/seconds).toFixed(0)+" OCR/s";
                rateStart=now;ticks=0;requests=0;
            }
            if(!statsPanel)return;
            if(statsPanel.parentElement!==host())host().appendChild(statsPanel);
            const sorted=[...timings].sort((x,y)=>x-y);
            const percentile=p=>sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]?.toFixed(1) ?? "–";
            statsPanel.textContent="本机 OCR · P50/P95 "+percentile(.5)+"/"+percentile(.95)+" ms · CPU "+
                (perf?.cpu ?? "–")+"% · 工作集 "+(perf?.mb ?? "–")+" MiB · 缓存匹配 "+
                Math.round(100*cachedFrames/Math.max(1,totalFrames))+"% · "+rateText;
        }
        let period=0, lastRecognized=null, failures=0, retryAt=0;
        function similar(x,y){
            if(!x || !y || x.width!==y.width || x.height!==y.height)return false;
            // Cheap veto for reusing blank predictions; recheck at least every 160 ms.
            let difference=0,count=0;
            for(let j=0;j<x.height;j+=3)for(let i=0;i<x.width;i+=5){
                const k=4*(j*x.width+i);
                if(Math.abs(x.data[k]-y.data[k])>15)difference++;
                count++;
            }
            return difference<=count*0.001;
        }
        async function recognize(surface){
            requests++;
            const started=performance.now();
            const image=surface.toDataURL("image/jpeg",0.88).split(",")[1];
            const result=await browser.runtime.sendMessage({type:"ocr",image});
            perf=result.perf;
            if(perf){timings.push(perf.ms);if(timings.length>120)timings.shift();}
            period=Math.min(160,period*0.65+(performance.now()-started)*0.35);
            return result;
        }
        let plans=[], preparing=false, usedPlan=null, lastCacheAttempt=-Infinity;
        v.setAttribute("data-subtitle-blur-selected","");
        function startCache(){
            document.dispatchEvent(new Event("subtitle-blur-cache-start"));
            lastCacheAttempt=performance.now();
        }
        startCache();
        let active=true, busy=false, epoch=0, current=null, masks=[], callback, lastSent=-Infinity;
        const clear=()=>{for(const m of masks)m.el.remove(); masks=[];};
        const reset=()=>{epoch++;current=null;clear();lastRecognized=null;lastSent=-Infinity;
            plans=[];usedPlan=null;holdUntil=-Infinity;safeEnglish=[];previousTime=null;
            earlyPlan=null;previousAhead=null;previousPresented=null;frameIntervals.length=0;};
        stop=()=>{active=false;reset();v.cancelVideoFrameCallback(callback);
            statsPanel?.remove();toggleStats=null;
            v.removeAttribute("data-subtitle-blur-selected");
            document.dispatchEvent(new Event("subtitle-blur-cache-stop"));
            v.removeEventListener("seeking",reset);v.removeEventListener("emptied",ended);
            window.removeEventListener("pagehide",ended);clearInterval(watch);stop=null;};
        const ended=()=>{if(active)stop();};
        const watch=setInterval(()=>{if(!v.isConnected)ended();else if(active){layout();updateStats();}},200);
        v.addEventListener("seeking",reset);v.addEventListener("emptied",ended);
        window.addEventListener("pagehide",ended);
        function layout() {
            const r=videoRect(v);
            for(const m of masks) {
                if(m.el.parentElement!==host())host().appendChild(m.el);
                const [x,y,right,bottom]=m.box;
                place(m.el,r.x+(a.x+a.w*x/canvas.width)*r.w,r.y+(a.y+a.h*y/canvas.height)*r.h,
                    (right-x)/canvas.width*a.w*r.w,(bottom-y)/canvas.height*a.h*r.h);
            }
        }
        function overlap(a,b) {
            return Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])) *
                Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
        }
        // Keep a single straight-edged rectangle per Chinese box. For each
        // English intersection choose the cut that preserves most Chinese ink.
        function clipEnglish(box,core,guards) {
            for(const guard of guards) {
                if(!overlap(box,guard))continue;
                const [x,y,r,b]=box,[l,t,u,v]=guard;
                const choices=[[x,y,r,t],[x,v,r,b],[x,y,l,b],[u,y,r,b]]
                    .filter(q=>q[2]>q[0] && q[3]>q[1] && overlap(q,core)>0);
                if(!choices.length)return null;
                choices.sort((a,b)=>overlap(b,core)-overlap(a,core) || overlap(b,b)-overlap(a,a));
                box=choices[0];
            }
            return box;
        }
        let safeEnglish=[],holdUntil=-Infinity,earlyPlan=null,previousAhead=null;
        function show(snapshot,result,early=false) {
            const guards=early?[...safeEnglish,...result.english]:result.english;
            if(!early)safeEnglish=result.english;
            const next=[];
            for(const core of result.chinese) {
                const keys=signature(snapshot,core);
                if(!early && !stillVisible(snapshot,current,keys))continue;
                const [x,y,right,bottom]=core;
                const pad=Math.max(1,Math.round((bottom-y)*0.15));
                const padded=[Math.max(0,x-pad),Math.max(0,y-pad),
                    Math.min(snapshot.width,right+pad),Math.min(snapshot.height,bottom+pad)];
                const box=clipEnglish(padded,core,guards);
                if(!box)continue;
                const el=layer("backdrop-filter:blur(16px) brightness(.9);background:rgba(0,0,0,.2);border:0;border-radius:0");
                next.push({el,box,core,keys,snapshot,lastHit:performance.now(),misses:0,checkedTime:previousTime});
            }
            const held=[];
            for(const m of masks){
                const box=clipEnglish(m.box,m.core,guards);
                if(!box || next.some(n=>overlap(n.box,m.box)>0)){m.el.remove();continue;}
                m.box=box;held.push(m);
            }
            masks=[...next,...held];layout();
        }
        function read(source,surface,context){
            context.drawImage(source,a.x*source.videoWidth,a.y*source.videoHeight,
                a.w*source.videoWidth,a.h*source.videoHeight,0,0,surface.width,surface.height);
            return context.getImageData(0,0,surface.width,surface.height);
        }
        function predict(frameTime) {
            if(preparing || v.paused || v.mediaKeys)return;
            const preview=document.querySelector("video[data-subtitle-blur-preview]");
            if(!preview){
                if(performance.now()-lastCacheAttempt>3000)startCache();
                return;
            }
            // Seek to the middle of a source frame, but timestamp its mask at the
            // frame start. A boundary seek may decode the previous frame.
            const step=frameDuration;
            const tail=plans.length?plans[plans.length-1].end:frameTime;
            const lead=Math.max(.18,.55*v.playbackRate);
            const framesAhead=Math.max(1,Math.ceil((Math.max(frameTime+lead,tail)-frameTime)/step-0.001));
            const at=frameTime+framesAhead*step;
            const sampleTime=at+step/2;
            if(at>frameTime+horizon || preview.readyState<1)return;
            const ranges=preview.buffered;
            if(!Array.from({length:ranges.length},(_,i)=>i).some(i=>ranges.start(i)<=at && ranges.end(i)>at+step))return;
            const generation=epoch;
            preparing=true;
            function seekSnapshot(target){
                return new Promise((resolve,reject)=>{
                    const done=()=>{
                        clearTimeout(timer);preview.removeEventListener("seeked",ready);
                    };
                    const ready=()=>{
                        done();
                        try{
                            if(!active || generation!==epoch || preview.videoWidth!==v.videoWidth)
                                throw Error("Preview changed");
                            resolve(read(preview,aheadCanvas,aheadCtx));
                        }catch(error){reject(error);}
                    };
                    const timer=setTimeout(()=>{done();reject(Error("Preview seek timed out"));},900);
                    preview.addEventListener("seeked",ready,{once:true});
                    try{preview.currentTime=target;}catch(error){done();reject(error);}
                });
            }
            (async()=>{
                try{
                    const snapshot=await seekSnapshot(sampleTime);
                    const prior=previousAhead;
                    const reuse=prior && at>=prior.at && at-prior.ocrTime<.3 && similar(prior.snapshot,snapshot);
                    const result=reuse?prior.result:await recognize(aheadCanvas);
                    if(!active || generation!==epoch)return;
                    previousAhead={at,snapshot,result,ocrTime:reuse?prior.ocrTime:at};
                    const keys=result.chinese.map(b=>signature(snapshot,b));
                    let start=at;
                    // Sparse OCR can land several frames into a new subtitle. Find
                    // its first matching buffered frame before scheduling the lead.
                    if(keys.length && prior && prior.at<at &&
                        !keys.every(k=>stillVisible(snapshot,prior.snapshot,k))){
                        let older=Math.min(12,Math.round((at-prior.at)/step)), newer=0;
                        while(older-newer>1){
                            const mid=Math.floor((older+newer)/2);
                            const probe=await seekSnapshot(at-mid*step+step/2);
                            if(keys.every(k=>stillVisible(snapshot,probe,k)))newer=mid;
                            else older=mid;
                        }
                        start=at-newer*step;
                    }
                    if(active && generation===epoch && at+step>v.currentTime)
                        plans.push({start,end:at+step,snapshot,result,boxes:result.chinese,keys});
                }catch{
                    if(active && generation===epoch)document.dispatchEvent(new Event("subtitle-blur-cache-stop"));
                }finally{preparing=false;}
            })();
        }
        async function requestOcr(snapshot) {
            busy=true;lastSent=performance.now();
            const generation=epoch;
            try {
                const result=await recognize(canvas);
                if(!active || epoch!==generation || !current)return;
                failures=0;lastRecognized=snapshot;
                if(v.currentTime>=holdUntil && (!masks.length || !usedPlan || usedPlan.end<=v.currentTime))
                    show(snapshot,result);
            } catch(err) {
                if(active && epoch===generation){
                    lastRecognized=null;failures++;
                    if(failures>=3){stop();notify("字幕识别失败：" + (err.message || err));}
                    else retryAt=performance.now()+250*failures;
                }
            } finally {busy=false;}
        }
        function prearm(time){
            if(!current || v.paused || v.seeking || document.hidden || time<holdUntil)return;
            const upcoming=plans.find(p=>p!==earlyPlan && p.start>time &&
                p.start-time<=2.02*frameDuration && p.boxes.length);
            if(!upcoming)return;
            // A continuing line is already covered. A new line can need a
            // larger rectangle even while the old subtitle is still visible.
            if(upcoming.boxes.every((b,i)=>stillVisible(upcoming.snapshot,current,upcoming.keys[i]) &&
                masks.some(m=>overlap(m.box,b)>=overlap(b,b)*.98)))return;
            earlyPlan=upcoming;holdUntil=upcoming.start+frameDuration/2;
            show(upcoming.snapshot,upcoming.result,true);
        }
        function frame(now,metadata) {
            if(!active)return;
            try {
                const clock=performance.now();
                current=read(v,canvas,ctx);
                const time=metadata?.mediaTime ?? v.currentTime;
                const presented=metadata?.presentedFrames;
                if(previousTime!==null && previousPresented!=null && presented>previousPresented){
                    const dt=(time-previousTime)/(presented-previousPresented);
                    if(dt>=1/240 && dt<=.25){
                        frameIntervals.push(dt);
                        if(frameIntervals.length>15)frameIntervals.shift();
                        frameDuration=[...frameIntervals].sort((a,b)=>a-b)[Math.floor(frameIntervals.length/2)];
                    }
                }
                previousPresented=presented;
                if(metadata)ticks++;
                previousTime=time;totalFrames++;
                plans=plans.filter(p=>p.end>time);
                // If English previously occupied the Chinese position, release its old guard
                // as soon as the incoming glyphs match the buffered Chinese frame.
                if(earlyPlan && time>=earlyPlan.start-frameDuration &&
                    earlyPlan.keys.some(keys=>stillVisible(earlyPlan.snapshot,current,keys))){
                    show(earlyPlan.snapshot,earlyPlan.result);usedPlan=earlyPlan;
                    earlyPlan=null;holdUntil=-Infinity;
                }
                if(earlyPlan && time>=earlyPlan.end)earlyPlan=null;
                const aligned=plans.find(p=>p.start<=time && time<p.end &&
                    (p.keys.length?p.keys.some(keys=>stillVisible(p.snapshot,current,keys)):similar(p.snapshot,current)));
                const plan=aligned || plans.find(p=>p.start>time && p.start-time<=.25 &&
                    p.keys.length && p.keys.every(keys=>stillVisible(p.snapshot,current,keys)));
                if(plan)cachedFrames++;
                if(plan && plan!==usedPlan && time>=holdUntil){
                    show(plan.snapshot,plan.result);usedPlan=plan;
                }
                masks=masks.filter(m=>{
                    if(time<holdUntil)return true;
                    if(retainMask(m,stillVisible(m.snapshot,current,m.keys),time,clock))return true;
                    m.el.remove();lastSent=-Infinity;return false;
                });
                const elapsed=clock-lastSent;
                const reusable=elapsed<160 && similar(lastRecognized,current);
                if(!busy && clock>=retryAt && !reusable &&
                    (!plan || (plan.boxes.length && !masks.length)) && elapsed>=period)
                    requestOcr(current);
                prearm(time);
                if(clock>=retryAt)predict(time);
                callback=v.requestVideoFrameCallback(frame);
            } catch(err) {stop();notify("无法读取该视频的原始画面（跨域、受保护或视频不可用）。");}
        }
        frame();
    }
})();
