import type { Outcome } from './smtp';

const definiteRejections = new Map<number,string>([
  [400,'invalid_news_message'],
  [401,'unauthorized'],
  [404,'not_found'],
  [409,'message_identity_conflict'],
  [413,'invalid_size'],
]);

// Only the Pro's bounded, documented pre-SMTP responses prove that no new
// submission succeeded. Arbitrary proxy/tunnel/server failures stay unknown.
export function classifyDefiniteProRejection(status:number,error:unknown):Outcome|null {
  return typeof error==='string' && definiteRejections.get(status)===error?'permanent_failure':null;
}
