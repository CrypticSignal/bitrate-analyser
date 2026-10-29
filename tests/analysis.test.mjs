import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze,parsePacket,normalizeMetadata} from '../src/analysis.js';
test('exactly three seconds retains all three full intervals',()=>{
 const r=analyze(Array.from({length:75},(_,i)=>({time:i/25,size:1000,duration:.04})));
 assert.deepEqual(r.points.map(p=>p.time),[0,1,2]);assert.ok(Math.abs(r.bitrate_mbps.mean-.2)<1e-12);assert.deepEqual(r.partial_seconds,[]);
});
test('negative timestamps use floor and gaps are explicit',()=>{
 const r=analyze([{time:-.04,size:100},{time:2.1,size:200}],{includePartial:true});
 assert.deepEqual(r.points.map(p=>p.time),[-1,0,1,2]);assert.equal(r.seconds_without_packets,2);
});
test('partial seconds are opt-in; missing packets are not invented',()=>{
 assert.throws(()=>analyze([{time:0,size:100}]),/No full one-second intervals/);
 assert.equal(analyze([{time:0,size:100}],{includePartial:true}).points[0].bytes,100);
});
test('GOP boundary and final variable duration produce known rates',()=>{
 const r=analyze([{time:0,size:100,duration:.1,keyframe:true},{time:.1,size:200,duration:.2},
 {time:.3,size:300,duration:.1,keyframe:true},{time:.4,size:400,duration:.3}],{mode:'gop'});
 assert.equal(r.gop.count,2);assert.ok(Math.abs(r.points[1].duration-.4)<1e-12);assert.ok(Math.abs(r.points[1].bitrate_mbps-.014)<1e-12);
});
test('invalid timestamps, sparse streams and audio GOP errors remain actionable',()=>{
 assert.throws(()=>analyze([{time:NaN,size:100}]),/No valid/);
 assert.throws(()=>analyze([{time:0,size:100}],{mode:'gop',video:false}),/video/);
});
test('compact packet parsing handles DTS, N/A, flags and side-data lines',()=>{
 assert.deepEqual(parsePacket('stream_index=0|dts_time=-0.04|duration_time=0.04|size=1200|flags=K__','dts'),{time:-.04,size:1200,duration:.04,keyframe:true});
 assert.equal(parsePacket('pts_time=N/A|size=12','pts'),false);
 assert.equal(parsePacket('side_data_type=Skip Samples','pts'),null);
});
test('stream metadata tolerates unknown frame rates and preserves indices',()=>{
 const r=normalizeMetadata({streams:[{index:2,codec_type:'audio',codec_name:'aac',avg_frame_rate:'0/0'}]});
 assert.equal(r.streams[0].fps,0);assert.equal(r.streams[0].index,2);
});

test('low frame rate needs no packet-coverage heuristic',()=>{
 const r=analyze([{time:0,size:100,duration:.5},{time:.5,size:200,duration:.5}]);
 assert.equal(r.points.length,1);assert.equal(r.points[0].bytes,300);
});
test('fractional edges are excluded; empty full intervals contribute zero',()=>{
 const data=[{time:.2,size:100,duration:.2},{time:2.2,size:200,duration:.2}];
 const full=analyze(data);
 assert.deepEqual(full.points.map(p=>p.time),[1]);assert.equal(full.bitrate_mbps.mean,0);
 assert.deepEqual(full.partial_seconds,[0,2]);
 const all=analyze(data,{includePartial:true});assert.deepEqual(all.points.map(p=>p.time),[0,1,2]);
 assert.equal(all.points[0].bitrate_mbps,.0008);assert.equal(all.points[0].duration,1);
});
test('unknown final duration is conservative and excessive timestamp gaps are bounded',()=>{
 assert.equal(analyze([{time:0,size:100},{time:1,size:100}]).points.length,1);
 assert.throws(()=>analyze([{time:0,size:1},{time:3000000,size:1}]),/interval limit/);
});
