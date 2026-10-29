/** Browser/WASM vs native FFprobe integration; needs FFmpeg and Chromium. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,extname,resolve} from 'node:path';
import {createServer} from 'node:http';
import {analyze,normalizeMetadata} from '../src/analysis.js';
const temp=await mkdtemp(join(tmpdir(),'bitrate-wasm-tests-'));
function run(command,args){const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;}
function media(name,args){const path=join(temp,name);run('ffmpeg',['-v','error',...args,path]);return path;}
const input=['-f','lavfi','-i','testsrc2=size=160x90:rate=25'];
const video=media('bframes.mp4',[...input,'-f','lavfi','-i','sine=sample_rate=48000','-t','3.2','-c:v','libx264','-g','25','-bf','2','-c:a','aac']);
const multi=media('multi.mp4',['-i',video,'-map','0:v:0','-map','0:a:0','-map','0:a:0','-c','copy','-disposition:a:0','0','-disposition:a:1','default']);
const audio=media('audio.mp3',['-f','lavfi','-i','sine=sample_rate=48000','-t','3.2','-c:a','libmp3lame']);
const flac=media('audio.flac',['-f','lavfi','-i','sine=sample_rate=48000','-t','3.2']);
const mkv=media('video.mkv',[...input,'-t','3.2','-c:v','libvpx-vp9','-g','25']);
const ts=media('video.ts',[...input,'-t','3.2','-c:v','libx264','-g','25','-f','mpegts']);
const short=media('short.wav',['-f','lavfi','-i','sine=sample_rate=48000','-t','0.2']);
const bad=join(temp,'invalid.mp4');await writeFile(bad,'not a media file');
const requests=[],pageErrors=[];
const server=createServer(async(req,res)=>{
 try{const name=new URL(req.url,'http://local').pathname;const path=resolve('dist','.'+(name==='/'?'/index.html':name));
  if(!path.startsWith(resolve('dist')+'/')){res.writeHead(403).end();return;}
  const data=await readFile(path);res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.html':'text/html'}[extname(path)]||'text/plain','Cache-Control':'max-age=3600'});res.end(data);
 }catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.TEST_BROWSER_EXECUTABLE?{executablePath:process.env.TEST_BROWSER_EXECUTABLE}:{}),args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('request',r=>requests.push({url:r.url(),method:r.method()}));page.on('pageerror',e=>pageErrors.push(e.message));
 await page.goto(origin);
 assert.ok(await page.evaluate(()=>Math.abs(document.querySelector('.chart-panel').getBoundingClientRect().top-document.querySelector('aside').getBoundingClientRect().top)<1),'Chart aligns with source panel');
 async function wasm(path,options={}){
  const bytes=await readFile(path);
  return page.evaluate(async({bytes,name,options})=>new Promise((resolve,reject)=>{
   const progress=[];
   const worker=new Worker('./probe-worker.js',{type:'module'});
   const timer=setTimeout(()=>{worker.terminate();reject(new Error('WASM test timeout'));},60000);
   const finish=()=>{clearTimeout(timer);worker.terminate();};
   worker.onmessage=({data})=>{if(data.type==='progress'){progress.push(data);}else if(data.type==='streams'){finish();resolve(data);}else if(data.type==='result'){finish();resolve({...data.result,test_progress:progress});}else if(data.type==='error'){finish();reject(new Error(data.message));}};
   worker.onerror=e=>{finish();reject(new Error(e.message));};
   worker.postMessage({file:new File([Uint8Array.from(atob(bytes),c=>c.charCodeAt(0))],name),mode:'seconds',timestamp:'pts',stream:'auto',includePartial:false,...options});
  }),{bytes:bytes.toString('base64'),name:path.split('/').at(-1),options});
 }
 // DASH parsing runs in the browser's XML parser; expected rates are independent.
 await page.evaluate(async()=>{
  const {parseDash,analyzeSegments}=await import('./segments.js');
  const check=(condition,message)=>{if(!condition)throw new Error(message);};
  const head='<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT3S"><Period><AdaptationSet contentType="video">';
  const tail='</AdaptationSet></Period></MPD>';
  const template=head+'<SegmentTemplate timescale="10" duration="20" media="seg$Number%03d$.m4s" initialization="init.mp4"/><Representation id="v" bandwidth="1000000"/>'+tail;
  const [r]=parseDash(template);
  check(r.segments[0].uri==='seg001.m4s'&&r.segments[1].duration===1,'DASH template duration / padding');
  const result=analyzeSegments(r,[{name:'seg001.m4s',size:250000},{name:'seg002.m4s',size:250000},{name:'init.mp4',size:10}],'main.mpd');
  check(result.average_mbps===4/3&&result.peak_mbps===2&&result.initialization_bytes===10,'DASH packaged segment rates');
  const timeline=head+'<Representation id="v"><SegmentTemplate timescale="1" media="$Time$.m4s"><SegmentTimeline><S t="0" d="1" r="-1"/></SegmentTimeline></SegmentTemplate></Representation>'+tail;
  check(parseDash(timeline)[0].segments.length===3,'DASH bounded negative repeat');
  const list=head+'<BaseURL>chunks/</BaseURL><Representation id="v"><SegmentList duration="3"><SegmentURL media="all.mp4" mediaRange="5-14"/></SegmentList></Representation>'+tail;
  const listed=parseDash(list)[0];check(listed.segments[0].uri==='chunks/all.mp4'&&listed.segments[0].range.length===10,'DASH list / BaseURL / byte ranges');
  for(const xml of ['<MPD><Period/><Period/></MPD>','<MPD type="dynamic"><Period/></MPD>','<broken>']){
   let failed=false;try{parseDash(xml);}catch{failed=true;}check(failed,'Unsupported MPD must fail');
  }
 });
 assert.equal(await page.locator('.bandwidth-panel').evaluate(panel=>panel.open),false);
 assert.equal(await page.locator('.segment-panel').evaluate(panel=>panel.open),false);
 assert.equal(await page.locator('#overhead').isVisible(),false);
 assert.equal(await page.locator('#segment-files').isVisible(),false);
 await page.locator('#bandwidth-title').click();await page.locator('#segment-title').click();
 assert.equal(await page.locator('#overhead').isVisible(),true);
 await page.locator('#segment-files').setInputFiles([
  {name:'media.m3u8',mimeType:'application/vnd.apple.mpegurl',buffer:Buffer.from('#EXTM3U\n#EXTINF:2,\na.ts\n#EXTINF:1,\nb.ts')},
  {name:'a.ts',mimeType:'video/mp2t',buffer:Buffer.alloc(250000)},
  {name:'b.ts',mimeType:'video/mp2t',buffer:Buffer.alloc(250000)}
 ]);
 await page.locator('#segment-output').waitFor({state:'visible'});
 assert.match(await page.locator('#segment-summary').innerText(),/1\.333 Mbps average · 2 Mbps peak/);
 assert.equal(await page.locator('#segment-rows tr').count(),2);
 assert.equal(await page.locator('#bandwidth-value').innerText(),'2.520 Mbps');
 await page.locator('#overhead').fill('10');await page.locator('#headroom').fill('50');
 assert.equal(await page.locator('#bandwidth-value').innerText(),'3.300 Mbps');
 await page.locator('#bandwidth-source').selectOption('segment-average');
 assert.equal(await page.locator('#bandwidth-value').innerText(),'2.200 Mbps');
 await page.locator('#overhead').fill('-1');assert.equal(await page.locator('#bandwidth-export').isDisabled(),true);
 await page.locator('#overhead').fill('5');await page.locator('#headroom').fill('20');

 const segmentDownload=page.waitForEvent('download');await page.locator('#segment-export').click();
 assert.equal((await segmentDownload).suggestedFilename(),'segment-bitrates.csv');
 const probe=await wasm(multi,{metadataOnly:true});
 assert.equal(probe.scanned_packets,0,'File information probe must not scan packets');
 assert.equal(probe.metadata.streams.length,3);
 function native(path,options={}){
  const data=JSON.parse(run('ffprobe',['-v','error','-show_packets','-show_streams','-show_format','-of','json',path]));
  const info=normalizeMetadata(data);const selected=options.stream&&options.stream!=='auto'?info.streams.find(s=>String(s.index)===options.stream):info.streams.find(s=>s.type==='video'&&!s.attached_picture)||info.streams.find(s=>s.type==='audio');
  const tracks=options.stream==='combined'?['video','audio'].map(type=>{const candidates=info.streams.filter(s=>s.type===type&&!s.attached_picture);return candidates.find(s=>s.default)||candidates[0];}).filter(Boolean):[selected];
  const packets=data.packets.filter(p=>tracks.some(s=>p.stream_index===s.index)).map(p=>({time:Number(p[`${options.timestamp||'pts'}_time`]),size:Number(p.size),duration:Number(p.duration_time)||(tracks.find(s=>s.index===p.stream_index).fps>0?1/tracks.find(s=>s.index===p.stream_index).fps:0),keyframe:p.flags?.includes('K')}));
  return analyze(packets,{mode:options.mode||'seconds',includePartial:options.includePartial||false,video:tracks[0].type==='video'});
 }
 for(const [path,options] of [[video,{}],[video,{timestamp:'dts',timeline:{start:0,duration:3.2}}],[video,{stream:'combined',timestamp:'dts'}],[multi,{stream:'combined',timestamp:'dts',includePartial:true}],[video,{mode:'gop'}],[video,{mode:'gop',timestamp:'dts'}],[video,{stream:'1'}],[audio,{}],[flac,{}],[mkv,{mode:'gop'}],[ts,{timestamp:'dts'}],[short,{includePartial:true}]]){
  const actual=await wasm(path,options),expected=native(path,options);
  for(const key of path===short?['total_bytes']:['total_packets','total_bytes'])assert.equal(actual[key],expected[key],`${path} ${key}`);
  assert.equal(actual.points.length,expected.points.length,`${path} interval count`);
  for(let i=0;i<actual.points.length;i++)for(const key of path===short?['time','duration','bytes','bitrate_mbps']:['time','duration','bytes','packets','bitrate_mbps'])assert.ok(Math.abs(actual.points[i][key]-expected.points[i][key])<1e-5,`${path} interval ${i} ${key}: ${actual.points[i][key]} vs ${expected.points[i][key]}`);
  if(options.stream==='combined'){assert.deepEqual(actual.selected_streams.map(s=>s.index),path===multi?[0,2]:[0,1]);assert.equal(actual.stream.index,'combined');for(const point of actual.points){assert.equal(point.video_bytes+point.audio_bytes,point.bytes);assert.ok(Math.abs(point.video_bitrate_mbps+point.audio_bitrate_mbps-point.bitrate_mbps)<1e-12);}}
  if(actual.comparison_data){
   const paired=native(path,{...options,stream:'combined'});
   assert.deepEqual(actual.comparison_data.points.map(p=>p.bytes),paired.points.map(p=>p.bytes));
   assert.ok(actual.comparison_data.points.some(p=>p.audio_bytes>0&&p.video_bytes>0));
  }
  assert.ok(actual.test_progress.some(p=>p.stage==='loading'));
  assert.ok(actual.test_progress.some(p=>p.stage==='scanning'&&p.packets>0));
  assert.ok(actual.test_progress.some(p=>p.stage==='calculating'));
  if(options.timeline)assert.ok(actual.test_progress.some(p=>p.stage==='scanning'&&Number.isFinite(p.percent)&&p.percent<100));
  console.log('Native parity:',path.split('/').at(-1),JSON.stringify(options));
 }
 await assert.rejects(()=>wasm(audio,{stream:'combined'}),/requires a video/);
 await assert.rejects(()=>wasm(video,{stream:'combined',mode:'gop'}),/one-second intervals/);
 await assert.rejects(()=>wasm(bad),/Invalid|invalid|media|input/i);
 await assert.rejects(()=>wasm(short),/partial seconds/);
 await assert.rejects(()=>wasm(audio,{mode:'gop'}),/video/);
 await page.locator('#file').setInputFiles(video);
 await page.locator('#cancel').click();
 assert.equal(await page.locator('#stream').isEnabled(),true);
 assert.equal(await page.locator('#analysis-progress').isVisible(),false);
 await page.locator('#file').setInputFiles(bad);
 await page.locator('.results[data-state="error"]').waitFor({timeout:60000});
 assert.equal(await page.locator('#stream').isEnabled(),true);
 assert.equal(await page.locator('#analysis-progress').isVisible(),false);
 assert.match(await page.locator('#message').innerText(),/Invalid|invalid|media|input/i);
 // Replacing an in-flight probe must not allow stale stream metadata through.
 await page.locator('#file').setInputFiles(audio);
 await page.locator('#file').setInputFiles(multi);
 await page.locator('.results[data-state="ready"]').waitFor({timeout:60000});
 assert.equal(await page.locator('#stream option').count(),5);
 assert.equal(await page.locator('#file-info').isVisible(),true);
 assert.ok(await page.evaluate(()=>Math.abs(document.querySelector('.chart-panel').getBoundingClientRect().top-document.querySelector('aside').getBoundingClientRect().top)<1),'Metadata must not displace the chart');
 const reported=JSON.parse(run('ffprobe',['-v','error','-show_format','-show_streams','-of','json',multi]));
 const summary=await page.locator('#file-summary').innerText();
 assert.ok(summary.includes(reported.format.format_name));
 assert.match(summary,/3\.200 s/);
 assert.ok(summary.includes((Number(reported.format.bit_rate)/1000).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2})+' kbps'));
 assert.equal(await page.locator('#file-streams section').count(),3);
 assert.match(await page.locator('#file-streams').innerText(),/avc1/);
 assert.match(await page.locator('#file-streams').innerText(),/160 × 90/);
 assert.match(await page.locator('#file-streams').innerText(),/48,000 Hz/);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.setViewportSize({width:1440,height:1000});

 assert.equal(await page.locator('#stream').inputValue(),'auto');
 await page.locator('#stream').selectOption('combined');
 assert.equal(await page.locator('#pairing').isVisible(),true);
 await page.locator('#audio-track').selectOption('1');
 await page.locator('#analyze').click();await page.locator('.results[data-state="complete"]').waitFor({timeout:60000});
 assert.match(await page.locator('#details').innerText(),/#0.*video.*#1.*audio/);
 assert.equal(await page.locator('#audio-track').inputValue(),'1');
 await page.locator('#stream').selectOption('2');
 await page.locator('#analyze').click();await page.locator('.results[data-state="complete"]').waitFor({timeout:60000});
 assert.match(await page.locator('#details').innerText(),/#2.*audio/);
 await page.locator('#file').setInputFiles(audio);
 await page.locator('.results[data-state="ready"]').waitFor({timeout:60000});
 assert.equal(await page.locator('#stream option').count(),2);
 assert.equal(await page.locator('#file-streams section').count(),1);
 assert.match(await page.locator('#file-summary').innerText(),/audio.mp3/);
 assert.equal(await page.locator('#stream').inputValue(),'auto');
 await page.locator('#file').setInputFiles(video);
 await page.locator('.results[data-state="ready"]').waitFor({timeout:60000});
 assert.equal(await page.locator('#stream option').count(),4);
 assert.equal(await page.locator('#stream').inputValue(),'auto');
 await page.locator('#analyze').click();
 await page.locator('.results[data-state="complete"]').waitFor({timeout:60000});
 assert.equal(await page.locator('#stream option').count(),4);
 assert.equal(await page.locator('#stream').inputValue(),'auto');
 assert.equal(await page.locator('[name=timestamp]:checked').inputValue(),'dts');
 assert.equal(await page.locator('#progress-bar').evaluate(bar=>bar.value),100);
 assert.equal(await page.locator('#progress-label').innerText(),'Analysis complete · 100%');
 // Comparison must work after the default Auto analysis, without another Analyze.
 const selectedAverage=await page.locator('#whole-average').innerText();
 await page.locator('#compare').check();
 assert.equal(await page.locator('#chart path[data-series]').count(),3);
 assert.match(await page.locator('#compare-note').innerText(),/#0 video.*#1 audio/);
 assert.equal(await page.locator('#whole-average').innerText(),selectedAverage);
 await page.locator('#compare').uncheck();
 assert.equal(await page.locator('#chart path[data-series]').count(),1);

 const rangeEntry=page.locator('#details dt').filter({hasText:'Analysis range'});
 assert.equal(await rangeEntry.locator('xpath=following-sibling::dd[1]').innerText(),'0 – 3 s');
 for(const id of ['whole-average','average','peak','minimum'])assert.match(await page.locator('#'+id).innerText(),/\d+(?:\.\d{3})?(?:Mbps|kbps|sec)$/);
 assert.match(await page.locator('#message').innerText(),/excluded from the chart and statistics: -0\.080-0 s, 3-3\.120 s\./);
 await page.locator('#stream').selectOption('combined');
 assert.equal(await page.locator('#mode option[value=gop]').evaluate(option=>option.disabled),true);
 await page.locator('#analyze').click();await page.locator('.results[data-state="complete"]').waitFor({timeout:60000});
 assert.equal(await page.locator('#stream').inputValue(),'combined');
 assert.match(await page.locator('#details').innerText(),/#0.*video.*#1.*audio/);
 assert.equal(await page.locator('#legend').innerText(),'Video + audio · Mbps');
 await page.locator('#compare').check();
 assert.equal(await page.locator('#chart path[data-series]').count(),3);
 assert.equal(await page.locator('#comparison-key').isVisible(),true);
 await page.locator('#chart svg').hover();assert.match(await page.locator('#tooltip').textContent(),/V .* A .* Σ /);
 const compareCsvPending=page.waitForEvent('download');await page.locator('#export-csv').click();
 const compareCsv=await compareCsvPending;
 assert.match(await readFile(await compareCsv.path(),'utf8'),/video_bytes,audio_bytes,video_bitrate_mbps,audio_bitrate_mbps/);
 const compareSvgPending=page.waitForEvent('download');await page.locator('#export-svg').click();
 const compareSvg=await compareSvgPending;
 assert.match(await readFile(await compareSvg.path(),'utf8'),/data-series="audio"/);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.setViewportSize({width:1440,height:1000});

 await page.locator('#stream').selectOption('1');await page.locator('#analyze').click();await page.locator('.results[data-state="complete"]').waitFor({timeout:60000});
 assert.equal(await page.locator('#stream option').count(),4);
 assert.equal(await page.locator('#compare').isEnabled(),true);
 await page.locator('#compare').check();
 assert.equal(await page.locator('#chart path[data-series]').count(),3);
 await page.locator('#compare').uncheck();
 assert.equal(await page.locator('#chart path[data-series]').count(),1);
 await page.locator('#stream').selectOption('0');await page.locator('#mode').selectOption('gop');await page.locator('#analyze').click();await page.locator('.results[data-state="complete"]').waitFor({timeout:60000});
 assert.ok(await page.locator('#gop-body tr').count()>0);
 assert.equal(await page.locator('#compare').isDisabled(),true);
 await page.locator('#filled').check();await page.locator('#chart svg').hover();
 for(const extension of ['json','csv','svg']){const pending=page.waitForEvent('download');await page.locator('#export-'+extension).click();const d=await pending;assert.ok(d.suggestedFilename().endsWith('.'+extension));}
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.locator('#analyze').click();await page.locator('.results[data-state="complete"]').waitFor({timeout:60000});
 await page.waitForFunction(()=>{const rect=document.querySelector('.chart-panel').getBoundingClientRect();return rect.top>=-1&&rect.top<50;});
 await page.locator('#analyze').click();await page.locator('#cancel').click();assert.equal(await page.locator('#analyze').isEnabled(),true);
 // Mobile browser emulation, with normal motion and first-analysis layout changes.
 const mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
 const mobile=await mobileContext.newPage();
 mobile.on('pageerror',e=>pageErrors.push(e.message));
 mobile.on('request',r=>requests.push({url:r.url(),method:r.method()}));
 await mobile.goto(origin);
 await mobile.locator('#file').setInputFiles(video);
 await mobile.locator('.results[data-state="ready"]').waitFor({timeout:60000});
 for(const motion of ['no-preference','reduce']){
  await mobile.emulateMedia({reducedMotion:motion});
  await mobile.locator('#analyze').click();
  await mobile.locator('.results[data-state="complete"]').waitFor({timeout:60000});
  await mobile.waitForFunction(()=>{const rect=document.querySelector('.chart-panel').getBoundingClientRect();return scrollY>0&&rect.top>=-1&&rect.top<50;},{},{timeout:5000});
 }
 await mobileContext.close();
 assert.deepEqual(pageErrors,[]);assert.ok(requests.every(r=>r.method==='GET'&&r.url.startsWith(origin+'/')),'No uploads or external requests');
 console.log('Browser UI, cancellation, exports, mobile layout, and no-upload checks passed.');
}finally{if(browser)await browser.close();server.close();await rm(temp,{recursive:true,force:true});}
