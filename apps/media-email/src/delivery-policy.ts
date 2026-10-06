interface DailyWork {
  mode_since_at?:string;
  start?:string;
  daily_time_local?:string;
  preference_updated_at?:string;
}
interface DailySubscription {
  status:string;
  delivery_mode:string;
  mode_since_at:string;
  digest_cursor_at:string;
  daily_time_local:string;
  updated_at:string;
}

const instant = (value:string|undefined):string|null => {
  const stamp=Date.parse(value??'');
  return Number.isFinite(stamp)?new Date(stamp).toISOString():null;
};
const localTime = (value:string|undefined):string|null => {
  const match=/^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(value??'');
  return match?`${match[1]}:${match[2]}`:null;
};

export function dailyWorkStillMatches(work:DailyWork,subscription:DailySubscription):boolean {
  return subscription.status==='active' && subscription.delivery_mode==='daily' &&
    instant(work.mode_since_at)===instant(subscription.mode_since_at) &&
    instant(work.start)===instant(subscription.digest_cursor_at) &&
    instant(work.preference_updated_at)===instant(subscription.updated_at) &&
    localTime(work.daily_time_local)!==null &&
    localTime(work.daily_time_local)===localTime(subscription.daily_time_local);
}

export function dailyCutoffIsDue(cutoff:string,cursor:string,preferenceUpdatedAt:string):boolean {
  const cutoffAt=instant(cutoff), cursorAt=instant(cursor), revisionAt=instant(preferenceUpdatedAt);
  return cutoffAt!==null && cursorAt!==null && revisionAt!==null && cutoffAt>cursorAt && cutoffAt>revisionAt;
}

export function digestRequiresOperator(itemCount:number,textBytes:number):boolean {
  return itemCount>500 || textBytes>180000;
}
