// Manifest sizes and durations only: no media decoding, network requests or WASM.
const LIMIT=100000;
const positive=value=>{const n=Number(value);if(!Number.isFinite(n)||n<=0)throw new Error('Missing or invalid segment duration / timescale.');return n;};
const bounded=rows=>{if(rows.length>LIMIT)throw new Error('Manifest exceeds 100,000 segments.');return rows;};
function range(value){
  const match=/^(\d+)-(\d+)$/.exec(value||'');
  if(!match||Number(match[2])<Number(match[1]))throw new Error('Invalid segment byte range.');
  return {offset:Number(match[1]),length:Number(match[2])-Number(match[1])+1};
}
export function parseHls(text){
  if(!text.trimStart().startsWith('#EXTM3U'))throw new Error('Not an HLS playlist.');
  if(/#EXT-X-(STREAM-INF|I-FRAME-STREAM-INF|MEDIA):/.test(text))throw new Error('Choose an HLS media playlist, rather than the master playlist.');
  if(/#EXT-X-(PART|SKIP):/.test(text))throw new Error('Low-latency partial / delta playlists are not supported. Choose a complete media playlist.');
  const segments=[],initialization=[];let duration=null,byteRange=null,previous=null;
  for(const line of text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)){
    if(line.startsWith('#EXTINF:'))duration=positive(line.slice(8).split(',')[0]);
    else if(line.startsWith('#EXT-X-BYTERANGE:'))byteRange=line.slice(17);
    else if(line.startsWith('#EXT-X-MAP:')){
      const attrs=Object.fromEntries([...line.slice(11).matchAll(/([A-Z-]+)=(?:"([^"]*)"|([^,]*))/g)].map(m=>[m[1],m[2]??m[3]]));
      if(!attrs.URI)throw new Error('Missing HLS initialization URI.');
      let bytes;
      if(attrs.BYTERANGE){const [length,offset]=attrs.BYTERANGE.split('@').map(Number);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<=0)throw new Error('Initialization byte range needs an explicit offset.');bytes={length,offset};}
      initialization.push({uri:attrs.URI,range:bytes});
    }else if(!line.startsWith('#')){
      if(duration===null)throw new Error('HLS segment is missing EXTINF duration.');
      let bytes;
      if(byteRange){
        const match=/^(\d+)(?:@(\d+))?$/.exec(byteRange);
        if(!match)throw new Error('Invalid HLS byte range.');
        const length=positive(match[1]);
        const offset=match[2]===undefined?(previous?.uri===line&&previous.range?previous.range.offset+previous.range.length:NaN):Number(match[2]);
        if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Implicit HLS byte range has no preceding range for that file.');
        bytes={length,offset};
      }
      previous={uri:line,duration,range:bytes};segments.push(previous);bounded(segments);duration=null;byteRange=null;
    }
  }
  if(duration!==null||!segments.length)throw new Error('No complete HLS segments found.');
  return [{id:'hls',label:'HLS media playlist',segments,initialization}];
}
const children=(node,name)=>[...node.children].filter(n=>n.localName===name);
const child=(node,name)=>children(node,name)[0];
function isoDuration(value){
  if(!value)return null;
  const m=/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if(!m)throw new Error('Unsupported DASH presentation duration.');
  return Number(m[1]||0)*86400+Number(m[2]||0)*3600+Number(m[3]||0)*60+Number(m[4]||0);
}
function timeline(node,scale,periodDuration,offset=0){
  const entries=children(node,'S'),rows=[];let time=0;
  for(let i=0;i<entries.length;i++){
    const s=entries[i],d=positive(s.getAttribute('d'));
    if(s.hasAttribute('t'))time=Number(s.getAttribute('t'));
    let repeat=Number(s.getAttribute('r')||0);
    if(repeat===-1){
      const next=entries[i+1];
      const end=next?.hasAttribute('t')?Number(next.getAttribute('t')):periodDuration===null?NaN:periodDuration*scale+offset;
      if(!Number.isFinite(end))throw new Error('An open DASH timeline needs a period duration.');
      repeat=Math.ceil((end-time)/d)-1;
    }
    if(!Number.isSafeInteger(repeat)||repeat<0||!Number.isSafeInteger(time)||rows.length+repeat+1>LIMIT)throw new Error('Invalid or excessive DASH timeline.');
    for(let j=0;j<=repeat;j++){rows.push({time,duration:d/scale});time+=d;}
  }
  return rows;
}
export function parseDash(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.getElementsByTagName('parsererror').length||doc.documentElement.localName!=='MPD')throw new Error('Invalid DASH MPD.');
  const mpd=doc.documentElement;
  if(mpd.getAttribute('type')==='dynamic')throw new Error('Choose a static DASH MPD; live manifests are not supported.');
  const periods=children(mpd,'Period');
  if(periods.length!==1)throw new Error('DASH analysis currently requires a single Period.');
  const period=periods[0],periodDuration=isoDuration(period.getAttribute('duration'))??isoDuration(mpd.getAttribute('mediaPresentationDuration'));
  const results=[];let totalSegments=0;
  for(const adaptation of children(period,'AdaptationSet'))for(const representation of children(adaptation,'Representation')){
    const hierarchy=[mpd,period,adaptation,representation];
    let base='https://segments.invalid/';
    for(const n of hierarchy){const b=child(n,'BaseURL');if(b)base=new URL(b.textContent.trim(),base).href;}
    const uri=value=>new URL(value,base).href.replace('https://segments.invalid/','');
    const lists=hierarchy.map(n=>child(n,'SegmentList')).filter(Boolean);
    const templates=hierarchy.map(n=>child(n,'SegmentTemplate')).filter(Boolean);
    const sources=lists.length?lists:templates;
    if(!sources.length)throw new Error('DASH SegmentBase is not supported. Use SegmentList or SegmentTemplate.');
    const attrs=Object.assign({},...sources.map(n=>Object.fromEntries([...n.attributes].map(a=>[a.name,a.value]))));
    const scale=positive(attrs.timescale||1),offset=Number(attrs.presentationTimeOffset||0);
    const tl=sources.map(n=>child(n,'SegmentTimeline')).filter(Boolean).at(-1);
    let timings=tl?timeline(tl,scale,periodDuration,offset):null;
    const initialization=[];let segments;
    if(lists.length){
      const list=lists.at(-1),urls=children(list,'SegmentURL');
      if(!timings)timings=urls.map((_,i)=>({time:i*positive(attrs.duration),duration:positive(attrs.duration)/scale}));
      if(timings.length!==urls.length)throw new Error('DASH SegmentList duration count does not match its URLs.');
      segments=urls.map((n,i)=>({uri:uri(n.getAttribute('media')||''),duration:timings[i].duration,range:n.hasAttribute('mediaRange')?range(n.getAttribute('mediaRange')):undefined}));
      const init=sources.map(n=>child(n,'Initialization')).filter(Boolean).at(-1);
      if(init)initialization.push({uri:uri(init.getAttribute('sourceURL')||''),range:init.hasAttribute('range')?range(init.getAttribute('range')):undefined});
    }else{
      if(!attrs.media)throw new Error('Missing DASH media template.');
      if(!timings){
        if(periodDuration===null)throw new Error('DASH duration template needs a presentation duration.');
        const d=positive(attrs.duration)/scale,count=Math.ceil(periodDuration/d);
        if(count>LIMIT)throw new Error('Manifest exceeds 100,000 segments.');
        timings=Array.from({length:count},(_,i)=>({time:i*Number(attrs.duration),duration:Math.min(d,periodDuration-i*d)}));
      }
      const start=Number(attrs.startNumber||1);
      const expand=(template,i,time)=>template.replace(/\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,(match,key,width)=>{
        if(match==='$$')return '$';
        const value={RepresentationID:representation.getAttribute('id'),Bandwidth:representation.getAttribute('bandwidth'),Number:start+i,Time:time}[key];
        if(value===null||value===undefined)throw new Error('Missing DASH template attribute.');
        if(width&&Number(width)>20)throw new Error('Excessive DASH template padding.');
        return String(value).padStart(Number(width)||0,'0');
      });
      segments=timings.map((t,i)=>({uri:uri(expand(attrs.media,i,t.time)),duration:t.duration}));
      if(attrs.initialization)initialization.push({uri:uri(expand(attrs.initialization,0,0))});
    }
    if(!segments.length)throw new Error('DASH representation has no segments.');
    totalSegments+=segments.length;if(totalSegments>LIMIT)throw new Error('Manifest exceeds 100,000 segments across representations.');
    results.push({id:String(results.length),label:`${adaptation.getAttribute('contentType')||adaptation.getAttribute('mimeType')||'Track'} · ${representation.getAttribute('id')||results.length} · ${representation.getAttribute('bandwidth')||'?'} bps declared`,segments:bounded(segments),initialization});
  }
  if(!results.length)throw new Error('No DASH representations found.');
  return results;
}
export function analyzeSegments(representation,files,manifestPath){
  const fileMap=new Map();
  for(const file of files){const path=file.webkitRelativePath||file.name;if(fileMap.has(path))throw new Error(`Duplicate selected path: ${path}`);fileMap.set(path,file);}
  const resolve=entry=>{
    const url=new URL(entry.uri,new URL(manifestPath,'https://segments.invalid/'));
    if(url.origin!=='https://segments.invalid')throw new Error('Remote segment URLs are not fetched. Use a manifest with local paths.');
    const path=decodeURIComponent(url.pathname.slice(1)),file=fileMap.get(path);
    if(!file)throw new Error(`Missing local segment: ${path}. Select the package folder to preserve paths.`);
    const bytes=entry.range?entry.range.length:file.size;
    if(entry.range&&(!Number.isSafeInteger(bytes)||bytes<=0||!Number.isSafeInteger(entry.range.offset)||entry.range.offset<0||entry.range.offset+bytes>file.size))throw new Error(`Byte range exceeds file: ${path}`);
    return {path,bytes};
  };
  let time=0,totalBytes=0,peak=0;
  const points=representation.segments.map((entry,i)=>{
    const duration=positive(entry.duration),{path,bytes}=resolve(entry),bitrate=bytes*8/duration/1e6;
    const point={segment:i+1,path,time,duration,bytes,bitrate_mbps:bitrate};time+=duration;totalBytes+=bytes;peak=Math.max(peak,bitrate);return point;
  });
  const initializations=[...new Map(representation.initialization.map(entry=>{const r=resolve(entry);return [`${r.path}:${entry.range?.offset??0}:${r.bytes}`,r];})).values()];
  return {label:representation.label,points,total_bytes:totalBytes,duration_seconds:time,average_mbps:totalBytes*8/time/1e6,peak_mbps:peak,initialization_bytes:initializations.reduce((sum,e)=>sum+e.bytes,0)};
}
