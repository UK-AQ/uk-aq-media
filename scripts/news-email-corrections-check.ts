import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { publicPreviewImageUrl } from '@uk-aq-media/core';
import { digestCursorRequest, digestRunStateAfterCursor, reconciliationOutcomeCommitted,
  reconciliationTargetAllows, rpc, type Env } from '../apps/media-email/src/common';
import { normalizeSupportedMailbox } from '../apps/media-email/src/mailbox';
import { dailyCutoffIsDue, dailyTimestampIdentity, dailyWorkIdentity, dailyWorkStillMatches,
  digestRequiresOperator } from '../apps/media-email/src/delivery-policy';
import { serialize } from '../apps/media-email/src/message';
import { articleMessage } from '../apps/media-email/src/presentation';
import { emailPreviewImageUrl, type EmailPreviewSelection } from '../apps/media-email/src/preview-image';
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

const imageSelection:EmailPreviewSelection={status:'approved',source_key:'bbc-news',
  canonical_domain:'bbc.co.uk',article_image_policy:'remote_preview',source_image_policy:'remote_preview',
  og_image_url:'https://ichef.bbci.co.uk/ace/standard/240/article.jpg?format=webp&width=800'};
assert.equal(emailPreviewImageUrl(imageSelection),imageSelection.og_image_url);
for(const status of ['pending','rejected','hidden'])
  assert.equal(emailPreviewImageUrl({...imageSelection,status}),null);
for(const policy of ['blocked','local_copy_permitted']) {
  assert.equal(emailPreviewImageUrl({...imageSelection,article_image_policy:policy}),null);
  assert.equal(emailPreviewImageUrl({...imageSelection,source_image_policy:policy}),null);
}
for(const og_image_url of [null,'invalid','http://ichef.bbci.co.uk/article.jpg',
  'https://ichef.bbci.co.uk.attacker.example/article.jpg','https://other.bbci.co.uk/article.jpg'])
  assert.equal(emailPreviewImageUrl({...imageSelection,og_image_url}),null);
for(const [source_key,canonical_domain,og_image_url] of [
  ['example','publisher.example','https://images.publisher.example/article.jpg'],
  ['the-guardian','theguardian.com','https://i.guim.co.uk/img/media/article.jpg?width=800'],
  ['dsawsp','dsawsp.org','https://cdn.prod.website-files.com/site/article.jpg'],
  ['mums-for-lungs','mumsforlungs.org',
    'https://images.squarespace-cdn.com/content/v1/60fe62a6c0eb074f99a31664/article.jpg?format=1500w'],
] as const) assert.equal(emailPreviewImageUrl({...imageSelection,source_key,canonical_domain,og_image_url}),og_image_url);
assert.equal(emailPreviewImageUrl({...imageSelection,source_key:'mums-for-lungs',
  canonical_domain:'mumsforlungs.org',
  og_image_url:'https://images.squarespace-cdn.com/content/v1/another-site/article.jpg'}),null);
assert.equal(emailPreviewImageUrl({...imageSelection,source_key:'example',
  canonical_domain:'publisher.example'}),null,'CDN exceptions remain source-specific');
assert.equal(emailPreviewImageUrl({...imageSelection,source_key:'communities-against-woodsmoke',
  og_image_url:null}),null,'email items without a publisher image remain text-only');
assert.match((await publicPreviewImageUrl('https://public.example',{
  ...imageSelection,id:1}))!,/^https:\/\/public\.example\/article-images\/1\?v=[a-f0-9]+$/,
'website previews retain the versioned Media proxy');

const linkToken='b'.repeat(64);
const manage=`https://test.example/news/#manage=${linkToken}`;
const unsubscribe=`https://test.example/news/#unsubscribe=${linkToken}`;
const {text,html}=articleMessage('https://test.example',[{title:'Example article',
  publisher:'Example publisher',canonical_url:'https://publisher.example/article',
  published_at:'2026-10-06T07:00:00.000Z',preview_image_url:null}],
  'daily',{manage_url:manage,unsubscribe_url:unsubscribe},'2026-10-06T08:00:00.000Z');
const wire=serialize({NEWS_EMAIL_SITE_ORIGIN:'https://test.example',
  NEWS_EMAIL_PUBLIC_API_ORIGIN:'https://api.example'} as Env,{
  kind:'daily',to:'reader@example.org',text,html,manage_url:manage,unsubscribe_url:unsubscribe,
  message_id:`<news.${'a'.repeat(64)}@ukaq.co.uk>`,date:'2026-10-06T08:00:00.000Z',
});
assert.equal(/(^|[^\r])\n/.test(wire),false);
assert.match(wire,/List-Unsubscribe: <https:\/\/api\.example\/one-click\/[a-f0-9]{64}>\r\n/);
const encodedBody=/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(wire)![1]!.trim().replace(/\r\n/g,'');
assert.equal(Buffer.from(encodedBody,'base64').toString('utf8'),text.replace(/\n/g,'\r\n'));
assert.throws(()=>serialize({NEWS_EMAIL_SITE_ORIGIN:'https://test.example',
  NEWS_EMAIL_PUBLIC_API_ORIGIN:'https://api.example'} as Env,{
  kind:'confirmation',to:'míke@example.org',text:'AQ in the News\n',html,
  message_id:`<news.${'a'.repeat(64)}@ukaq.co.uk>`,date:'2026-10-06T08:00:00.000Z',
}));

for(const kind of ['immediate','daily'] as const) {
  const article={title:'Example article',publisher:'BBC News',
    canonical_url:'https://bbc.co.uk/news/article',published_at:'2026-10-06T07:00:00.000Z',
    preview_image_url:emailPreviewImageUrl(imageSelection)};
  const links={manage_url:manage,unsubscribe_url:unsubscribe};
  const message=articleMessage('https://test.example',[article],kind,links,'2026-10-06T08:00:00.000Z');
  const thumbnail=/<a href="([^"]+)" aria-label="Read original article: [^"]*"><img class="article-preview" src="([^"]+)"/.exec(message.html);
  assert.equal(thumbnail?.[1],article.canonical_url);
  assert.equal(thumbnail?.[2],imageSelection.og_image_url!.replaceAll('&','&amp;'));
  assert.equal(message.html.includes('/article-images/'),false);
  const textOnly=articleMessage('https://test.example',[{...article,preview_image_url:null}],kind,
    links,'2026-10-06T08:00:00.000Z');
  assert.equal(textOnly.html.includes('class="article-preview"'),false);
  assert.equal(message.text,textOnly.text,'plain-text alternative is independent of thumbnail selection');
  const imageWire=serialize({NEWS_EMAIL_SITE_ORIGIN:'https://test.example',
    NEWS_EMAIL_PUBLIC_API_ORIGIN:'https://api.example'} as Env,{
    ...message,to:'reader@example.org',message_id:`<news.${'a'.repeat(64)}@ukaq.co.uk>`,
    date:'2026-10-06T08:00:00.000Z',
  });
  assert.equal((imageWire.match(/Content-Type: image\//g)??[]).length,2);
  assert.equal((imageWire.match(/Content-Type: image\/png/g)??[]).length,2);
  assert.equal((imageWire.match(/Content-ID: </g)??[]).length,2,'only the two UK AQ logos are embedded');
  const encodedHtml=/Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(imageWire)![1]!;
  const decodedHtml=Buffer.from(encodedHtml.replace(/\r\n/g,''),'base64').toString('utf8');
  assert.ok(decodedHtml.includes(`src="${thumbnail![2]}"`));
  assert.equal((decodedHtml.match(/src="cid:/g)??[]).length,2);
}

console.log('AQ in the News email correction checks passed.');
