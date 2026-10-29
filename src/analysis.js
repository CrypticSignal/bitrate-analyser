/** Pure packet calculations, ported from the Python web refactor. */
export function summarize(values) {
  let min=Infinity, max=-Infinity, sum=0;
  for(const value of values){min=Math.min(min,value);max=Math.max(max,value);sum+=value;}
  return {min,mean:sum/values.length,max};
}
export function analyze(input,{mode='seconds',includePartial=false,video=true}={}) {
  const packets=input.filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.size)&&p.size>=0).map(p=>({...p,duration:Math.max(0,finiteNumber(p.duration))})).sort((a,b)=>a.time-b.time);
  if(!packets.length)throw new Error('No valid packet timestamps found. Try a different stream or timestamp type.');
  let endTimestamp=packets[0].time;
  for(const p of packets)endTimestamp=Math.max(endTimestamp,p.time+p.duration);
  const points=[],partial=[];
  let missing=0;
  if(mode==='gop'){
    if(!video)throw new Error('GOP analysis requires a video stream.');
    const groups=[];
    for(const p of packets){if(p.keyframe)groups.push([]);if(groups.length)groups.at(-1).push(p);}
    for(let i=0;i<groups.length;i++){
      const group=groups[i];
      // A preceding packet can extend beyond the last timestamp (variable durations).
      let end=group[0].time;
      for(const p of group)end=Math.max(end,p.time+p.duration);
      if(i+1<groups.length)end=groups[i+1][0].time;
      const duration=end-group[0].time;
      if(duration<=0)continue;
      const size=group.reduce((sum,p)=>sum+p.size,0);
      points.push({time:group[0].time,duration,bytes:size,packets:group.length,bitrate_mbps:size*8/duration/1e6});
    }
    if(!points.length)throw new Error('No measurable GOPs found. The stream needs keyframes and packet durations.');
  }else{
    const buckets=new Map();
    for(const p of packets){const second=Math.floor(p.time);if(!buckets.has(second))buckets.set(second,[]);buckets.get(second).push(p);}
    // Bounds use the selected timestamp basis and packet durations, not
    // container duration (which may describe a different stream or PTS basis).
    const start=packets[0].time;
    const end=endTimestamp;
    const epsilon=1e-7;
    const first=Math.floor(start);
    const stop=Math.max(first+1,Math.floor(packets.at(-1).time)+1,Math.ceil(end-epsilon));
    if(stop-first>2_000_000)throw new Error('The timestamp range exceeds the two million interval limit.');
    for(let second=first;second<stop;second++){
      const group=buckets.get(second)||[];
      const complete=second>=start-epsilon&&second+1<=end+epsilon;
      if(complete||includePartial){
        const size=group.reduce((sum,p)=>sum+p.size,0);
        points.push({time:second,duration:1,bytes:size,packets:group.length,bitrate_mbps:size*8/1e6,complete});
        if(!group.length)missing++;
      }
      if(!complete)partial.push(second);
    }
    if(!points.length)throw new Error('No full one-second intervals found. Enable partial seconds for short clips.');
  }
  const result={mode,points,bitrate_mbps:summarize(points.map(p=>p.bitrate_mbps)),total_packets:packets.length,
    total_bytes:packets.reduce((sum,p)=>sum+p.size,0),first_timestamp:packets[0].time,last_timestamp:packets.at(-1).time,end_timestamp:endTimestamp,
    partial_seconds:partial,include_partial:includePartial,seconds_without_packets:missing};
  if(mode==='gop'){
    // Overall bits / elapsed time; averaging rates equally biases variable GOPs.
    result.bitrate_mbps.mean=points.reduce((sum,p)=>sum+p.bytes,0)*8/
      points.reduce((sum,p)=>sum+p.duration,0)/1e6;
    result.gop={count:points.length,duration_seconds:summarize(points.map(p=>p.duration)),
      packets:summarize(points.map(p=>p.packets)),size_megabits:summarize(points.map(p=>p.bytes*8/1e6))};
  }
  return result;
}
export function finiteNumber(value,fallback=0){
  if(value===undefined||value===null||value===''||value==='N/A')return fallback;
  const number=Number(value);return Number.isFinite(number)?number:fallback;
}
export function normalizeMetadata(data){
  const streams=(data.streams||[]).filter(s=>['audio','video'].includes(s.codec_type)).map(s=>{
    const [a,b]=String(s.avg_frame_rate||'0/1').split('/').map(Number);
    return {index:s.index,type:s.codec_type,attached_picture:!!Number(s.disposition?.attached_pic),default:!!Number(s.disposition?.default),codec:s.codec_name||'unknown',codec_long_name:s.codec_long_name||null,codec_tag:s.codec_tag_string||null,profile:s.profile||null,
      bit_rate:finiteNumber(s.bit_rate)>0?finiteNumber(s.bit_rate):null,duration:finiteNumber(s.duration,NaN)>=0?finiteNumber(s.duration):null,
      fps:Number.isFinite(a/b)?a/b:0,width:s.width===undefined?null:finiteNumber(s.width),height:s.height===undefined?null:finiteNumber(s.height),sample_rate:s.sample_rate??null,channels:s.channels===undefined?null:finiteNumber(s.channels)};
  });
  if(!streams.length)throw new Error('No audio or video streams found. This format may not be included in the WASM build.');
  return {duration:finiteNumber(data.format?.duration),container:{name:data.format?.format_name||null,long_name:data.format?.format_long_name||null,bit_rate:finiteNumber(data.format?.bit_rate)>0?finiteNumber(data.format.bit_rate):null,start_time:finiteNumber(data.format?.start_time,null)},streams};
}
export function parsePacket(line,timestamp,fps=0){
  const row=Object.fromEntries(line.trim().split('|').filter(p=>p.includes('=')).map(p=>{const at=p.indexOf('=');return [p.slice(0,at),p.slice(at+1)];}));
  // Compact output may contain a separate side-data-only line.
  if(!('size' in row))return null;
  const time=finiteNumber(row[`${timestamp}_time`],NaN),size=finiteNumber(row.size,-1);
  if(!Number.isFinite(time)||size<0)return false;
  return {time,size,duration:Math.max(0,finiteNumber(row.duration_time))||(Number.isFinite(fps)&&fps>0?1/fps:0),keyframe:(row.flags||'').includes('K')};
}

/** Choose one playable video and audio track; player language preferences may differ. */
export function playbackStreams(streams){
  const choose=type=>{
    const candidates=streams.filter(s=>s.type===type&&!s.attached_picture);
    return candidates.find(s=>s.default)||candidates[0];
  };
  const video=choose('video');
  if(!video)throw new Error('Combined bitrate requires a video stream. Select an audio stream instead.');
  return [video,choose('audio')].filter(Boolean);
}
