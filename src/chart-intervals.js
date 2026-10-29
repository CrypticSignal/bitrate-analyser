export function intervalBounds(point,timeline){
  return {start:Math.max(point.time,timeline.first_timestamp),end:Math.min(point.time+point.duration,timeline.end_timestamp)};
}
export function intervalAtTime(points,time){
  let lo=0,hi=points.length;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(points[mid].time<=time)lo=mid+1;else hi=mid;}
  return points[Math.max(0,lo-1)];
}
export function intervalPath(points,key,timeline,x,y){
  return points.map(point=>{
    const {start,end}=intervalBounds(point,timeline);
    // Independent horizontal segments: no implied instantaneous rate transitions.
    return `M${x(start)},${y(point[key])} H${x(end)}`;
  }).join(' ');
}
