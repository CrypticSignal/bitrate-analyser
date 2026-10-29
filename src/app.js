'use strict';
const $ = id => document.getElementById(id);
let result = null;
const fmt = (value, digits = 2) => Number(value).toLocaleString(undefined, {maximumFractionDigits: digits, minimumFractionDigits: digits});
function streamOptions(metadata){
  return [new Option('Auto · first video, otherwise audio','auto'),
    ...(!metadata||metadata.streams.some(s=>s.type==='video'&&!s.attached_picture)?[new Option('Combined · default video + audio','combined')]:[]),
    ...(metadata?.streams||[]).map(s=>new Option(`#${s.index} · ${s.type} · ${s.codec}`,String(s.index)))];
}
function updateMode(){
  const combined=$('stream').value==='combined';
  $('mode').querySelector('[value=gop]').disabled=combined;
  if(combined)$('mode').value='seconds';
  $('partial').disabled=$('mode').value==='gop';
  $('partial-hint').textContent=$('mode').value==='gop'?'GOP boundaries are determined by keyframe packet timestamps.':'Bitrate = packet bits in each fixed 1-second interval ÷ 1 second. By default, only full intervals within the stream’s packet timeline are included.';
}
$('stream').addEventListener('change',updateMode);
function sourceChanged() {
  if(activeWorker)fail('Source changed. Start a new analysis.');
  const file = $('file').files[0];
  $('file-name').textContent = file ? file.name : 'Drop a media file here';
  $('file-size').textContent = file ? `${fmt(file.size / 1024 / 1024, 1)} MB · ready to inspect` : 'or click to browse';
  $('stream').replaceChildren(...streamOptions());
  updateMode();
  if(!file)return;
  $('analyze').disabled=true;$('stream').disabled=true;$('cancel').hidden=false;
  $('status').textContent='Reading streams';$('message').className='';
  $('message').textContent='Reading stream information…';
  try{
    const worker=new Worker(new URL('./probe-worker.js',import.meta.url),{type:'module'});
    activeWorker=worker;
    worker.onmessage=({data})=>{
      if(activeWorker!==worker)return;
      if(data.type==='progress')$('message').textContent=data.message;
      else if(data.type==='streams'){
        $('stream').replaceChildren(...streamOptions(data.metadata));
        $('stream').value='auto';updateMode();finish();
        $('status').textContent='Streams ready';$('message').textContent='Choose a stream, then analyze the media.';
      }else if(data.type==='error')fail(data.message);
    };
    worker.onerror=()=>{if(activeWorker===worker)fail('Could not read streams. Check the media file and WASM assets.');};
    worker.postMessage({file,metadataOnly:true});
    activeTimer=setTimeout(()=>fail('Reading streams exceeded five minutes. Try a different file.'),300000);
  }catch(error){fail(error.message);}
}
$('file').addEventListener('change', sourceChanged);
['dragover', 'dragleave', 'drop'].forEach(type => $('dropzone').addEventListener(type, event => {
  event.preventDefault();
  $('dropzone').classList.toggle('dragover', type === 'dragover');
  if (type === 'drop' && event.dataTransfer.files.length) {
    const transfer = new DataTransfer(); transfer.items.add(event.dataTransfer.files[0]);
    $('file').files = transfer.files; sourceChanged();
  }
}));
$('mode').addEventListener('change',updateMode);
let activeWorker = null;
let activeTimer = null;
function finish() {
  if(activeWorker)activeWorker.terminate();
  activeWorker=null;clearTimeout(activeTimer);
  $('analyze').disabled=false;$('analyze').innerHTML='Analyze media <span>↗</span>';
  $('cancel').hidden=true;$('stream').disabled=false;
}
function fail(message) {
  $('message').className='error';$('message').textContent=message;
  $('status').textContent=result?'Previous result shown':'Analysis stopped';finish();
}
$('cancel').addEventListener('click',()=>fail('Analysis canceled. Your file has not left your device.'));
$('analysis-form').addEventListener('submit', event => {
  event.preventDefault();
  const file=$('file').files[0];
  if(!file)return;
  if(!('Worker' in window)||!('WebAssembly' in window)){fail('This browser needs Web Workers and WebAssembly support.');return;}
  $('analyze').disabled=true;$('analyze').textContent='Analyzing locally…';$('cancel').hidden=false;
  $('message').className='';$('message').textContent='Starting local analysis…';$('status').textContent='Analysis in progress';
  try {
    const worker=new Worker(new URL('./probe-worker.js',import.meta.url),{type:'module'});
    const selection=$('stream').value;
    activeWorker=worker;
    activeWorker.onmessage=({data})=>{
      if(activeWorker!==worker)return;
      if(data.type==='progress')$('message').textContent=data.message;
      else if(data.type==='metadata'){
        $('stream').replaceChildren(...streamOptions(data.metadata));
        $('stream').value=selection;
        updateMode();
      }else if(data.type==='result'){result=data.result;render();finish();}
      else if(data.type==='error')fail(data.message);
    };
    activeWorker.onerror=()=>{if(activeWorker===worker)fail('The browser could not run FFprobe. Check that the WASM assets are served correctly, or try a smaller file or another browser.');};
    activeWorker.postMessage({file,mode:$('mode').value,timestamp:document.querySelector('[name=timestamp]:checked').value,stream:$('stream').value,includePartial:$('partial').checked});
    activeTimer=setTimeout(()=>fail('Analysis exceeded five minutes. Try a shorter clip or a faster device.'),300000);
  }catch(error){fail(error.message);}
});
function metric(id, value, unit) {
  $(id).replaceChildren(document.createTextNode(fmt(value)), Object.assign(document.createElement('em'), {textContent: unit}));
}
function render() {
  const r = result, audio = r.stream.type === 'audio', scale = audio ? 1000 : 1, unit = audio ? 'kbps' : 'Mbps';
  $('result-title').textContent = r.filename;
  $('status').textContent = 'Analysis complete';
  ['average', 'peak', 'minimum'].forEach((id, i) => metric(id, r.bitrate_mbps[['mean','max','min'][i]] * scale, unit));
  metric('duration', r.metadata.duration || r.last_timestamp - r.first_timestamp, 'sec');
  const tracks=(r.selected_streams||[r.stream]).map(s=>`#${s.index} · ${s.type} / ${s.codec}`).join(' + ');
  $('stream-note').textContent = `${tracks} · ${r.timestamp}`;
  $('legend').textContent = `${r.stream.type==='combined'?'Video + audio':r.stream.type} · ${unit}`;
  $('chart-title').textContent = r.mode === 'gop' ? 'GOP bitrate over time' : 'Bitrate over time';
  $('average-note').textContent = `${r.mode === 'gop' ? 'Time-weighted across' : 'Across'} ${r.points.length.toLocaleString()} ${r.mode === 'gop' ? 'GOPs' : 'second buckets'}`;
  $('detail-text').textContent = `${r.total_packets.toLocaleString()} valid packets · ${fmt(r.total_bytes / 1e6)} MB of stream data · ${r.rejected_packets} rejected packets.`;
  const detail = {'Timestamp basis': r.timestamp, 'Selected streams': tracks, 'Observed timestamp range': `${fmt(r.first_timestamp, 3)} – ${fmt(r.last_timestamp, 3)} s`};
  if (r.engine) detail['Local engine'] = `FFprobe ${r.engine.ffprobe} · WASM`;
  if (r.stream.fps) detail['Average frame rate'] = `${fmt(r.stream.fps, 3)} FPS`;
  if (r.mode === 'seconds') detail['Seconds without packets'] = r.seconds_without_packets;
  $('details').replaceChildren(...Object.entries(detail).flatMap(([key,value]) => [Object.assign(document.createElement('dt'), {textContent:key}), Object.assign(document.createElement('dd'), {textContent:value})]));
  const selected = r.selection || String(r.stream.index);
  $('stream').replaceChildren(...streamOptions(r.metadata));
  $('stream').value = selected;
  updateMode();
  $('message').className = '';
  const partialRanges=r.partial_seconds.map(second=>`[${second}, ${second+1}) s`).join(', ');
  $('message').textContent = r.mode === 'seconds' && r.partial_seconds.length ? `${r.partial_seconds.length} partial start/end interval${r.partial_seconds.length===1?'':'s'} ${r.include_partial ? 'included as raw bits per one-second bucket' : 'excluded from the chart and statistics'}: ${partialRanges}.${r.include_partial?' Edge buckets may be lower.':''}` : '';
  $('chart-caption').textContent = `${r.timestamp} timestamps · ${r.points.length.toLocaleString()} intervals`;
  $('gop-panel').hidden = r.mode !== 'gop';
  if (r.gop) {
    $('gop-summary').textContent = `${r.gop.count} GOPs · duration ${fmt(r.gop.duration_seconds.min, 3)}–${fmt(r.gop.duration_seconds.max, 3)}s · average ${fmt(r.gop.packets.mean, 1)} packets/GOP`;
    $('gop-body').replaceChildren(...r.points.slice(0, 500).map((p,i) => {
      const tr = document.createElement('tr');
      [i+1, fmt(p.time,3), fmt(p.duration,3), p.packets, fmt(p.bitrate_mbps,3)].forEach(value => tr.append(Object.assign(document.createElement('td'), {textContent:value})));
      return tr;
    }));
    $('gop-note').textContent = r.points.length > 500 ? 'Showing the first 500 GOPs. Exports include all GOPs.' : 'Exports include all GOPs.';
  }
  ['export-svg','export-json','export-csv'].forEach(id => $(id).disabled = false);
  drawChart();
}
function drawChart() {
  if (!result) return;
  const r = result, points = r.points, scale = r.stream.type === 'audio' ? 1000 : 1;
  const width = Math.max(320, $('chart').clientWidth - 16), height = 350, left = 55, right = width - 15, top = 22, bottom = 300;
  const start = points[0].time, end = Math.max(start + 1, points.at(-1).time + points.at(-1).duration);
  const max = Math.max(...[r.bitrate_mbps.max * scale * 1.12, 0.001]);
  const x = t => left + (t-start)/(end-start)*(right-left), y = b => bottom-b*scale/max*(bottom-top);
  // Bound SVG size while preserving peaks and troughs in each display column.
  const sampled = [];
  const stride = Math.max(1, Math.ceil(points.length / 900));
  for (let i=0; i<points.length; i+=stride) {
    const group = points.slice(i, i+stride);
    const low = group.reduce((a,b) => a.bitrate_mbps < b.bitrate_mbps ? a : b);
    const high = group.reduce((a,b) => a.bitrate_mbps > b.bitrate_mbps ? a : b);
    sampled.push(...[...new Set([group[0], low, high, group.at(-1)])].sort((a,b) => a.time-b.time));
  }
  let grid = '';
  for(let i=0;i<=4;i++) {
    const yy=top+(bottom-top)*i/4, value=max*(1-i/4);
    grid += `<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" stroke="#2b3c3b"/><text x="${left-13}" y="${yy+4}" text-anchor="end">${fmt(value,2)}</text>`;
    const t=start+(end-start)*i/4, xx=x(t);
    grid += `<text x="${xx}" y="${bottom+26}" text-anchor="middle">${fmt(t,1)}s</text>`;
  }
  const path = sampled.map((p,i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(2)},${y(p.bitrate_mbps).toFixed(2)}`).join(' ');
  const fill = $('filled').checked ? `<path d="${path} L${x(sampled.at(-1).time)},${bottom} L${x(sampled[0].time)},${bottom} Z" fill="#baf28a" opacity=".12"/>` : '';
  const unit = scale === 1 ? 'Mbps' : 'kbps';
  $('chart').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bitrate over time in ${unit}"><rect width="${width}" height="350" fill="#142022"/><g font-family="system-ui,sans-serif" font-size="12" fill="#91a69c">${grid}<text x="${left}" y="13">${unit}</text></g>${fill}<path d="${path}" fill="none" stroke="#baf28a" stroke-width="2" stroke-linejoin="round"/><line id="cursor" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="#799b75" visibility="hidden"/><text id="tooltip" x="${right}" y="14" text-anchor="end" fill="#dbeecf" font-family="system-ui" font-size="12"></text></svg>`;
  const svg = $('chart').querySelector('svg');
  svg.addEventListener('pointermove', event => {
    const point = new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    const time = start+(point.x-left)/(right-left)*(end-start);
    let lo=0, hi=points.length-1;
    while(lo<hi){const mid=Math.floor((lo+hi)/2);if(points[mid].time<time)lo=mid+1;else hi=mid;}
    const p = lo>0 && Math.abs(points[lo-1].time-time)<Math.abs(points[lo].time-time) ? points[lo-1] : points[lo];
    const cursor = svg.querySelector('#cursor'); cursor.setAttribute('x1',x(p.time)); cursor.setAttribute('x2',x(p.time)); cursor.setAttribute('visibility','visible');
    svg.querySelector('#tooltip').textContent = `${fmt(p.time,3)}s · ${fmt(p.bitrate_mbps*scale,3)} ${unit}`;
  });
  svg.addEventListener('pointerleave', () => {svg.querySelector('#cursor').setAttribute('visibility','hidden');svg.querySelector('#tooltip').textContent='';});
}
$('filled').addEventListener('change', drawChart);
function download(content,type,extension) {
  const url=URL.createObjectURL(new Blob([content],{type})), a=document.createElement('a');
  a.href=url; a.download=`${result.filename}.${result.mode}.${extension}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export-json').addEventListener('click',()=>download(JSON.stringify(result,null,2),'application/json','json'));
$('export-csv').addEventListener('click',()=>download('time_seconds,duration_seconds,bytes,packets,bitrate_mbps\n'+result.points.map(p=>[p.time,p.duration,p.bytes,p.packets,p.bitrate_mbps].join(',')).join('\n'),'text/csv','csv'));
$('export-svg').addEventListener('click',()=>download(new XMLSerializer().serializeToString($('chart').querySelector('svg')),'image/svg+xml','svg'));

window.addEventListener('resize', drawChart);
