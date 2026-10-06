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

export function dailyTimestampIdentity(value:string|undefined):string|null {
  return typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
}
export function dailyWorkIdentity(subscription:Pick<DailySubscription,
  'mode_since_at'|'digest_cursor_at'|'updated_at'>):Pick<DailyWork,
  'mode_since_at'|'start'|'preference_updated_at'>|null {
  const modeSince=dailyTimestampIdentity(subscription.mode_since_at);
  const start=dailyTimestampIdentity(subscription.digest_cursor_at);
  const preferenceUpdated=dailyTimestampIdentity(subscription.updated_at);
  return modeSince!==null&&start!==null&&preferenceUpdated!==null
    ? {mode_since_at:modeSince,start,preference_updated_at:preferenceUpdated}:null;
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
  const workIdentity=dailyWorkIdentity({mode_since_at:work.mode_since_at??'',
    digest_cursor_at:work.start??'',updated_at:work.preference_updated_at??''});
  const subscriptionIdentity=dailyWorkIdentity(subscription);
  return subscription.status==='active' && subscription.delivery_mode==='daily' &&
    workIdentity!==null && subscriptionIdentity!==null &&
    workIdentity.mode_since_at===subscriptionIdentity.mode_since_at &&
    workIdentity.start===subscriptionIdentity.start &&
    workIdentity.preference_updated_at===subscriptionIdentity.preference_updated_at &&
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
