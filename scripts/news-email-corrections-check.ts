import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { digestCursorRequest, digestRunStateAfterCursor, reconciliationOutcomeCommitted,
  reconciliationTargetAllows, rpc, type Env } from '../apps/media-email/src/common';
import { normalizeSupportedMailbox } from '../apps/media-email/src/mailbox';
import { dailyCutoffIsDue, dailyTimestampIdentity, dailyWorkIdentity, dailyWorkStillMatches,
  digestRequiresOperator } from '../apps/media-email/src/delivery-policy';
import { serialize } from '../apps/media-email/src/message';
import { classifyDefiniteProRejection } from '../apps/media-email/src/transport-policy';

let rpcHeaders=new Headers();
const originalFetch=globalThis.fetch;
globalThis.fetch=async (_input,init) => {
  rpcHeaders=new Headers(init?.headers);
  return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
};
await rpc({SUPABASE_URL:'https://example.supabase.co',SB_SECRET_KEY:'sb_secret_test'} as Env,'get',{});
globalThis.fetch=originalFetch;
assert.equal(rpcHeaders.get('apikey'),'sb_secret_test');
assert.equal(rpcHeaders.has('Authorization'),false);
assert.equal(reconciliationTargetAllows(null,'temporary_failure'),true);
assert.equal(reconciliationTargetAllows('temporary_failure','temporary_failure'),true);
assert.equal(reconciliationTargetAllows('temporary_failure','permanent_failure'),false);
assert.equal(reconciliationOutcomeCommitted({ok:true,outcome:'temporary_failure'},'temporary_failure'),true);
assert.equal(reconciliationOutcomeCommitted(
  {ok:false,conflict:true,outcome:'accepted'},'temporary_failure'),false);

assert.equal(normalizeSupportedMailbox('  News.Tag+daily@Example-Domain.co.uk  '),
  'news.tag+daily@example-domain.co.uk');
for (const mailbox of [
  'mike@example',
  '.mike@example.org',
  'mike..news@example.org',
  'mike@-example.org',
  'mike@example-.org',
  'míke@example.org',
  'mike@exämple.org',
  `${String.fromCodePoint(0x212a)}ate@example.org`, // Kelvin sign must not case-fold into ASCII K.
  `${'a'.repeat(65)}@example.org`,
  `mike@${'a'.repeat(64)}.org`,
]) assert.equal(normalizeSupportedMailbox(mailbox), null, mailbox);

const dailyWork = {
  mode_since_at: '2026-10-06T19:31:16.662522+00:00',
  start: '2026-10-05T07:00:00.123456+00:00',
  daily_time_local: '08:00:00',
  preference_updated_at: '2026-10-05T06:00:00.987654+00:00',
};
const dailySubscription = {
  status: 'active',
  delivery_mode: 'daily',
  mode_since_at: dailyWork.mode_since_at,
  digest_cursor_at: dailyWork.start,
  daily_time_local: '08:00:00',
  updated_at: dailyWork.preference_updated_at,
};
assert.equal(dailyTimestampIdentity(dailyWork.mode_since_at),dailyWork.mode_since_at);
assert.deepEqual(dailyWorkIdentity(dailySubscription),{
  mode_since_at:dailyWork.mode_since_at,
  start:dailyWork.start,
  preference_updated_at:dailyWork.preference_updated_at,
});
assert.equal(dailyWorkStillMatches(dailyWork, dailySubscription), true);
assert.equal(dailyWorkStillMatches(dailyWork, {...dailySubscription, daily_time_local: '09:00:00'}), false);
assert.equal(dailyWorkStillMatches(dailyWork,
  {...dailySubscription, updated_at:'2026-10-05T06:00:00.987655+00:00'}), false);
assert.equal(dailyWorkStillMatches(dailyWork, {...dailySubscription, delivery_mode: 'immediate'}), false);
const emptyCursorRequest=digestCursorRequest({...dailyWork,subscription_id:'subscription-1',
  cutoff:'2026-10-06T07:00:00.000Z'},'empty');
assert.equal(emptyCursorRequest.expected_preference_updated_at,dailyWork.preference_updated_at);
assert.equal(digestRunStateAfterCursor('empty',{ok:false,advanced:false}),'cancelled');
assert.equal(digestRunStateAfterCursor('empty',{ok:true,advanced:true}),'completed');
const acceptedCursorRequest=digestCursorRequest({...dailyWork,subscription_id:'subscription-1',
  cutoff:'2026-10-06T07:00:00.000Z'},'accepted');
assert.equal(Object.hasOwn(acceptedCursorRequest,'expected_preference_updated_at'),false);
assert.equal(digestRunStateAfterCursor('accepted',{ok:false,advanced:false}),'completed');
assert.equal(dailyCutoffIsDue('2026-10-05T08:00:00.000Z', '2026-10-05T07:00:00.000Z',
  '2026-10-06T07:01:00.000Z'), false);
assert.equal(dailyCutoffIsDue('2026-10-06T08:00:00.000Z', '2026-10-05T07:00:00.000Z',
  '2026-10-06T07:01:00.000Z'), true);
assert.equal(digestRequiresOperator(500,180000), false);
assert.equal(digestRequiresOperator(501,1000), true);
assert.equal(digestRequiresOperator(1,180001), true);

for (const [status, error] of [
  [400, 'invalid_news_message'], [401, 'unauthorized'], [404, 'not_found'],
  [409, 'message_identity_conflict'], [413, 'invalid_size'],
] as const) assert.equal(classifyDefiniteProRejection(status, error), 'permanent_failure');
assert.equal(classifyDefiniteProRejection(500, 'invalid_news_message'), null);
assert.equal(classifyDefiniteProRejection(400, 'unexpected'), null);
assert.equal(classifyDefiniteProRejection(401, undefined), null);

const linkToken='b'.repeat(64);
const manage=`https://test.example/news/#manage=${linkToken}`;
const unsubscribe=`https://test.example/news/#unsubscribe=${linkToken}`;
const text=`AQ NEWS\n\nManage preferences: ${manage}\nUnsubscribe: ${unsubscribe}\n`;
const wire=serialize({NEWS_EMAIL_SITE_ORIGIN:'https://test.example',
  NEWS_EMAIL_PUBLIC_API_ORIGIN:'https://api.example'} as Env,{
  kind:'daily',to:'reader@example.org',text,manage_url:manage,unsubscribe_url:unsubscribe,
  message_id:`<news.${'a'.repeat(64)}@ukaq.co.uk>`,date:'2026-10-06T08:00:00.000Z',
});
assert.equal(/(^|[^\r])\n/.test(wire),false);
assert.match(wire,/List-Unsubscribe: <https:\/\/api\.example\/one-click\/[a-f0-9]{64}>\r\n/);
const encodedBody=wire.split('\r\n\r\n',2)[1]!.trim().replace(/\r\n/g,'');
assert.equal(Buffer.from(encodedBody,'base64').toString('utf8'),text.replace(/\n/g,'\r\n'));
assert.throws(()=>serialize({NEWS_EMAIL_SITE_ORIGIN:'https://test.example',
  NEWS_EMAIL_PUBLIC_API_ORIGIN:'https://api.example'} as Env,{
  kind:'confirmation',to:'míke@example.org',text:'AQ NEWS\n',
  message_id:`<news.${'a'.repeat(64)}@ukaq.co.uk>`,date:'2026-10-06T08:00:00.000Z',
}));

console.log('AQ NEWS email correction checks passed.');
