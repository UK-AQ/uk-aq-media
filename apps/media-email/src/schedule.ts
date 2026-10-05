// London cutoffs use wall time. Repeated autumn times choose the first occurrence;
// nonexistent spring times choose 02:00. A cutoff is always a stable UTC instant.
const london=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',
  day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function parts(ms:number):{date:string;time:string} {
  const p=Object.fromEntries(london.formatToParts(ms).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}
export function cutoffAt(at:string,time:string):string {
  const current=Date.parse(at), date=parts(current).date;
  const midnight=Date.parse(`${date}T00:00:00Z`), wanted=time.slice(0,5);
  const minutes=Number(wanted.slice(0,2))*60+Number(wanted.slice(3,5));
  for(let day=0;day<3;day++) {
    const base=midnight-day*86400000, targetDate=new Date(base).toISOString().slice(0,10);
    const wall=base+minutes*60000;
    const matches=[wall-3600000,wall].filter(candidate=>{
      const local=parts(candidate);return local.date===targetDate && local.time===wanted;
    });
    // In the London spring gap the first valid later local minute is 02:00 BST.
    const candidate=matches.length?Math.min(...matches):base+3600000;
    if(candidate<=current) return new Date(candidate).toISOString();
  }
  throw new Error('cutoff_unavailable');
}
