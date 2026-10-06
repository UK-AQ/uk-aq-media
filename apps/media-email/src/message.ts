import { Buffer } from 'node:buffer';
import { encoder, type Delivery, type Env } from './common';
import { normalizeSupportedMailbox } from './mailbox';

export interface Message { kind:string; text:string; manage_url?:string; unsubscribe_url?:string }
export interface Submission extends Message { to:string; message_id:string; date:string }
const subjects:Record<string,string> = {
  confirmation:'Confirm your AQ NEWS email subscription',
  immediate:'AQ NEWS: a newly approved article', daily:'Your daily AQ NEWS update',
};

export function submission(delivery:Delivery,recipient:string,message:Message):Submission {
  return {...message,to:recipient,message_id:delivery.message_id,date:delivery.created_at};
}

// V1 uses an ASCII addr-spec (SMTPUTF8 mailboxes fail closed), fixed ASCII header
// text and a UTF-8/base64 body. Article/publisher text never becomes a header.
export function serialize(env:Env,message:Submission):string {
  if(!normalizeSupportedMailbox(message.to)) throw new Error('invalid_news_message');
  const subject=Object.hasOwn(subjects,message.kind)?subjects[message.kind]:undefined;
  const date=new Date(message.date);
  if(!subject || !/^<news\.[a-f0-9]{64}@ukaq\.co\.uk>$/.test(message.message_id) ||
    !Number.isFinite(date.getTime()) || !message.text.startsWith('AQ NEWS\n') ||
    encoder.encode(message.text).length>180000) throw new Error('invalid_news_message');
  const headers=[
    'From: UK AQ News <news@ukaq.co.uk>', 'Reply-To: news@ukaq.co.uk',
    `To: <${message.to}>`, `Subject: ${subject}`,
    `Date: ${date.toUTCString().replace('GMT','+0000')}`, `Message-ID: ${message.message_id}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ];
  if(message.kind!=='confirmation') {
    for(const [purpose,link] of [['manage',message.manage_url],['unsubscribe',message.unsubscribe_url]]) {
      const prefix=`${env.NEWS_EMAIL_SITE_ORIGIN}/news/#${purpose}=`;
      if(!link?.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(link.slice(prefix.length)) ||
        !message.text.includes(link)) throw new Error('invalid_news_message');
    }
    const api=new URL(env.NEWS_EMAIL_PUBLIC_API_ORIGIN);
    if(api.protocol!=='https:' || api.origin!==env.NEWS_EMAIL_PUBLIC_API_ORIGIN)
      throw new Error('invalid_news_message');
    const token=message.unsubscribe_url!.split('=')[1]!;
    headers.push(`List-Unsubscribe: <${api.origin}/one-click/${token}>`,
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }
  const text=message.text.replace(/\r\n|\r|\n/g,'\r\n');
  const body=Buffer.from(text,'utf8').toString('base64').match(/.{1,76}/g)!.join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}
