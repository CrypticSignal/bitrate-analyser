export function intervalBounds(point,timeline){
  return {start:Math.max(point.time,timeline.first_timestamp),end:Math.min(point.time+point.duration,timeline.end_timestamp)};
}
export function intervalAtTime(points,time){
  let lo=0,hi=points.length;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(points[mid].time<=time)lo=mid+1;else hi=mid;}
  return points[Math.max(0,lo-1)];
}
export function stepPath(points,key,timeline,x,y){
  let previousEnd=null;
  return points.map(point=>{
    const {start,end}=intervalBounds(point,timeline);
    const contiguous=previousEnd!==null&&Math.abs(start-previousEnd)<1e-7;
    previousEnd=end;
    // Do not extend a sampled value across omitted intervals.
    return `${contiguous?'V'+y(point[key]):'M'+x(start)+','+y(point[key])} H${x(end)}`;
  }).join(' ');
}
