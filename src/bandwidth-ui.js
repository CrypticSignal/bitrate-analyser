import {estimateBandwidth} from './bandwidth.js';
const $=id=>document.getElementById(id),sources=new Map();
const fmt=value=>value.toFixed(3).replace(/\.000$/,'');
let estimate=null;
function render(){
  const source=sources.get($('bandwidth-source').value);
  try{
    if(!source)throw new Error('Analyze media or local segments to calculate an estimate.');
    const overhead=$('overhead').value.trim(),headroom=$('headroom').value.trim();
    if(!overhead||!headroom)throw new Error('Enter both overhead and headroom percentages.');
    estimate={source:source.label,...estimateBandwidth(source.value,Number(overhead),Number(headroom))};
    $('bandwidth-value').textContent=`${fmt(estimate.estimate_mbps)} Mbps`;
    $('bandwidth-detail').textContent=`${source.label}: ${fmt(estimate.base_mbps)} Mbps × ${fmt(1+estimate.overhead_percent/100)} (overhead) × ${fmt(1+estimate.headroom_percent/100)} (headroom).`;
    $('bandwidth-export').disabled=false;
  }catch(e){estimate=null;$('bandwidth-value').textContent='—';$('bandwidth-detail').textContent=e.message;$('bandwidth-export').disabled=true;}
}
function update(entries,preferred){
  for(const [key,label,value] of entries){sources.set(key,{label,value});}
  $('bandwidth-source').replaceChildren(...[...sources].map(([key,s])=>new Option(s.label,key)));
  $('bandwidth-source').value=preferred;render();
}
window.addEventListener('bitrate-result',({detail:r})=>update([
  ['media-peak','Selected media: peak displayed interval',r.bitrate_mbps.max],
  ['media-average','Selected media: whole-stream average',r.overall_bitrate_mbps]
],'media-peak'));
window.addEventListener('segment-result',({detail:r})=>update([
  ['segment-peak','Local segments: peak segment',r.peak_mbps],
  ['segment-average','Local segments: duration-weighted average',r.average_mbps]
],'segment-peak'));
for(const id of ['bandwidth-source','overhead','headroom'])$(id).addEventListener('input',render);
$('bandwidth-export').addEventListener('click',()=>{
  if(!estimate)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(estimate,null,2)],{type:'application/json'})),a=document.createElement('a');
  a.href=url;a.download='bandwidth-estimate.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
render();
