import createFFmpegCore from './vendor/ffmpeg-core.js';
import {analyze,normalizeMetadata,parsePacket,finiteNumber,playbackStreams} from './analysis.js';
const MAX_PACKETS=2_000_000;
// WORKERFS reads slices of the read-only browser File; no input MEMFS copy.
self.onmessage=async({data:{file,mode,timestamp,stream,includePartial}})=>{
  let core,mounted=false;
  try{
    if(!file?.size)throw new Error('Choose a nonempty media file.');
    self.postMessage({type:'progress',message:'Loading FFprobe WebAssembly…'});
    const wasmURL=new URL('./vendor/ffmpeg-core.wasm',import.meta.url).href;
    core=await createFFmpegCore({mainScriptUrlOrBlob:import.meta.url+'#'+btoa(JSON.stringify({wasmURL}))});
    if(typeof core._ffprobe!=='function'||!core.FS.filesystems.WORKERFS)throw new Error('The loaded WASM build needs FFprobe and WORKERFS support.');
    core.FS.mkdir('/input');
    const suffix=(file.name.match(/\.[a-z0-9]{1,12}$/i)||[''])[0];
    const name='media'+suffix,path='/input/'+name;
    core.FS.mount(core.FS.filesystems.WORKERFS,{blobs:[{name,data:file}]},'/input');mounted=true;
    const streams=[],byStream=new Map(),rejectedByStream=new Map();let duration=0,errors='',seen=0,version='unknown';
    core.setLogger(({type,message})=>{
      if(type!=='stdout'){errors=(errors+'\n'+message).slice(-3000);return;}
      const parts=message.split('|'),kind=parts.shift();
      const row=Object.fromEntries(parts.filter(p=>p.includes('=')).map(p=>{const i=p.indexOf('=');return [p.slice(0,i),p.slice(i+1)];}));
      if(kind==='packet'){
        if(++seen>MAX_PACKETS)throw new Error('This file exceeds the two million packet limit. Choose a shorter clip.');
        const packet=parsePacket(parts.join('|'),timestamp);
        if(packet===false){const index=Number(row.stream_index);rejectedByStream.set(index,(rejectedByStream.get(index)||0)+1);}
        else if(packet){const index=Number(row.stream_index);if(!byStream.has(index))byStream.set(index,[]);byStream.get(index).push(packet);}
        if(seen%25000===0)self.postMessage({type:'progress',message:`Read ${seen.toLocaleString()} packets locally…`});
      }else if(kind==='stream'){
        streams.push({...row,index:Number(row.index),disposition:{attached_pic:Number(row['disposition:attached_pic']),default:Number(row['disposition:default'])}});
      }else if(kind==='format')duration=finiteNumber(row.duration);
      else if(kind==='program_version')version=row.version||'unknown';
    });
    const args=['./ffprobe','-v','error','-protocol_whitelist','file','-threads','1'];
    args.push('-show_packets','-show_streams','-show_format','-show_program_version','-show_entries',
      'packet=stream_index,pts_time,dts_time,duration_time,size,flags:stream=index,codec_name,codec_type,width,height,avg_frame_rate,sample_rate,channels:stream_disposition=attached_pic,default:format=duration:program_version=version',
      '-of','compact=p=1',path);
    self.postMessage({type:'progress',message:'Inspecting packets on your device…'});
    // core 0.12.10's JS ffprobe() wrapper discards the C return value and
    // returns its untouched ret=-1. Use the exported C entrypoint so failures
    // are checked correctly. This worker invokes it once, then is destroyed.
    const code=core._ffprobe(args.length,core.stringsToPtr(args));
    if(code!==0)throw new Error(errors.trim()||'FFprobe could not read this media. The format may not be included in this WASM build.');
    const info=normalizeMetadata({streams,format:{duration}});
    const combined=stream==='combined';
    if(combined&&mode==='gop')throw new Error('Combined video + audio bitrate uses one-second intervals. Select a single video stream for GOP analysis.');
    const selectedStreams=combined?playbackStreams(info.streams):[stream==='auto'?info.streams.find(s=>s.type==='video'&&!s.attached_picture)||(info.streams.find(s=>s.type==='audio')||info.streams[0]):info.streams.find(s=>String(s.index)===stream)];
    if(!selectedStreams[0])throw new Error('Stream index not found in this file.');
    const selected=combined?{index:'combined',type:'combined',codec:selectedStreams.map(s=>s.codec).join(' + '),fps:0}:selectedStreams[0];
    self.postMessage({type:'metadata',metadata:info,stream:selected});
    // Keep the original shared timeline; never align tracks to separate zero points.
    const packets=[];
    for(const track of selectedStreams){
      for(const p of byStream.get(track.index)||[]){
        if(!p.duration&&track.type==='video'&&track.fps>0)p.duration=1/track.fps;
        packets.push(p);
      }
    }
    const result=analyze(packets,{mode,includePartial,video:selected.type==='video'});
    result.selected_streams=selectedStreams;
    result.filename=file.name;result.file_bytes=file.size;result.timestamp=timestamp.toUpperCase();
    result.engine={core:'@ffmpeg/core@0.12.10',ffprobe:version};result.metadata=info;result.stream=selected;result.rejected_packets=selectedStreams.reduce((sum,s)=>sum+(rejectedByStream.get(s.index)||0),0);
    self.postMessage({type:'result',result});
  }catch(error){self.postMessage({type:'error',message:error.message||String(error)});}
  finally{if(mounted){try{core.FS.unmount('/input');}catch{}}self.close();}
};
