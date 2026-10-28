import { branding } from './branding';
import type { Message } from './message';

export interface EmailArticle {
  title:string; publisher:string; canonical_url:string; published_at:string|null;
  preview_image_url:string|null;
}
interface Links { manage_url:string; unsubscribe_url:string }
const font = "'Inter', 'Segoe UI', Roboto, Arial, sans-serif";
const escape = (value:string):string => value.replace(/[&<>"']/g,
  char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const anchor = (url:string,label:string):string =>
  `<a href="${escape(url)}" style="color:#285b88;text-decoration:underline;">${label}</a>`;

export function publicationDate(value:string|null):string {
  if(!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',
    day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(value));
}
function publisherUrl(value:string):string {
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)
    throw new Error('invalid_publisher_url');
  return url.href;
}
function shell(site:string,preheader:string,content:string,footer:string):string {
  const news=`${site}/news/`;
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AQ in the News</title>
<style>@media screen and (max-width:620px){.email-shell{width:100%!important}.email-pad{padding:23px 20px!important}.daily-text,.daily-image{display:block!important;width:100%!important;max-width:none!important;box-sizing:border-box!important}.daily-image{padding-top:16px!important;padding-left:0!important}.email-logo{width:100%!important;max-width:450px!important;height:auto!important}.daily-item{padding-bottom:22px!important}.uk-aq-logo-cell{width:66px!important}.uk-aq-home-logo{width:66px!important;height:auto!important}.article-preview{max-width:100%!important;height:auto!important;aspect-ratio:16/9!important}}</style></head>
<body style="margin:0;padding:0;background:#fbfaf7;color:#101822;font-family:${font};">
<div style="display:none;font-size:1px;color:#fbfaf7;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#fbfaf7;"><tr><td align="center" style="padding:30px 12px 44px;">
<!--[if mso]><table role="presentation" width="640" align="center"><tr><td><![endif]-->
<table role="presentation" class="email-shell" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;background:#ffffff;border:1px solid #eadfd2;border-radius:13px;"><tr><td class="email-pad" style="padding:32px 39px 35px;font-family:${font};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 15px;border-collapse:collapse;table-layout:fixed;"><tr>
<td valign="middle" style="padding:0 14px 0 0;vertical-align:middle;"><h1 style="margin:0;padding:0;font-size:0;line-height:0;"><a href="${escape(news)}" aria-label="AQ in the News" style="text-decoration:none;border:0;"><img class="email-logo" src="cid:${branding.heading.content_id}" width="450" height="52" alt="AQ in the News" style="display:block;width:450px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;color:#101822;font-family:Arial,sans-serif;font-size:24px;line-height:1.3;"></a></h1></td>
<td class="uk-aq-logo-cell" width="86" align="right" valign="top" style="width:86px;padding:0;text-align:right;vertical-align:top;"><a href="${escape(`${site}/`)}" aria-label="UK AQ homepage" title="Visit the UK AQ homepage" style="display:inline-block;text-decoration:none;border:0;"><img class="uk-aq-home-logo" src="cid:${branding.logo.content_id}" width="86" height="${Math.round(86*branding.logo.height/branding.logo.width)}" alt="UK AQ" style="display:block;width:86px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;"></a></td>
</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr><td style="padding:0 0 24px;"><img src="cid:${branding.divider.content_id}" width="450" height="6" alt="" style="display:block;width:450px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;"></td></tr></table>
${content}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:31px;border-top:1px solid #eadfd2;"><tr><td style="padding-top:22px;font-size:13px;line-height:1.9;color:#526273;">${footer}</td></tr></table>
</td></tr></table><!--[if mso]></td></tr></table><![endif]-->
<div style="font-size:11px;line-height:1.7;color:#6d7884;padding:19px 12px 0;">AQ in the News &nbsp;·&nbsp; UK Air Quality &nbsp;·&nbsp; <a href="${escape(`${site}/`)}" style="color:#6d7884;text-decoration:underline;">ukaq.co.uk</a></div>
</td></tr></table></body></html>`;
}
const brandFooterText = (site:string):string =>
  `AQ in the News · UK Air Quality · ukaq.co.uk\nWebsite: ${site}/`;
function articleMarkup(article:EmailArticle,daily:boolean):string {
  const url=publisherUrl(article.canonical_url), date=publicationDate(article.published_at);
  const heading=daily?'h3':'h2';
  const copy=`<p style="font-size:${daily?12:14}px;line-height:${daily?1.4:1.5};color:#526273;margin:0 0 ${daily?9:10}px;">${escape(article.publisher)}${date?` &nbsp;·&nbsp; ${date}`:''}</p>
<${heading} style="font-size:${daily?18:28}px;${daily?'':'letter-spacing:-.5px;'}line-height:${daily?1.35:1.25};margin:0 0 ${daily?12:24}px;font-weight:750;overflow-wrap:break-word;"><a href="${escape(url)}" style="color:#101822;text-decoration:none;">${escape(article.title)}</a></${heading}>`;
  const imageWidth=daily?160:320, imageHeight=daily?90:180;
  const image=article.preview_image_url?
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${imageWidth}" style="width:${imageWidth}px;max-width:100%;margin:0;border-collapse:collapse;"><tr><td><a href="${escape(url)}" aria-label="Read original article: ${escape(article.title)}"><img class="article-preview" src="${escape(article.preview_image_url)}" width="${imageWidth}" height="${imageHeight}" alt="Article preview from ${escape(article.publisher)}" style="display:block;border:1px solid #dae4ec;box-sizing:border-box;border-radius:8px;width:${imageWidth}px;max-width:100%;height:${imageHeight}px;aspect-ratio:16/9;object-fit:cover;background:#e8eef3;"></a></td></tr></table>`:'';
  if(!daily) return `${copy}${image?`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 0 24px;">${image}</td></tr></table>`:''}
<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr><td bgcolor="#3c78ac" style="border-radius:7px;"><a href="${escape(url)}" style="display:inline-block;padding:13px 21px;border-radius:7px;background:#3c78ac;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Read original article &#8594;</a></td></tr></table>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #eadfd2;"><tr><td class="daily-item" style="padding:22px 0 23px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="daily-text" valign="top" style="${image?'width:68%;padding-right:17px;':''}">
${copy}<a href="${escape(url)}" style="font-size:13px;font-weight:700;color:#285b88;text-decoration:underline;">Read original article &#8594;</a></td>
${image?`<td class="daily-image" width="160" valign="top" style="width:160px;padding-left:0;">${image}</td>`:''}
</tr></table></td></tr></table>`;
}
export function articleMessage(site:string,articles:EmailArticle[],kind:'immediate'|'daily',
  links:Links,date:string):Message {
  if(!articles.length || (kind==='immediate'&&articles.length!==1)) throw new Error('invalid_article_count');
  const news=`${site}/news/`, daily=kind==='daily';
  const label=`Daily update · ${publicationDate(date)} · ${articles.length} ${articles.length===1?'article':'articles'}`;
  const text=articles.map(a=>`${a.title}\n${a.publisher}${publicationDate(a.published_at)?` · ${publicationDate(a.published_at)}`:''}\nRead original article: ${publisherUrl(a.canonical_url)}`).join('\n\n');
  const footer=`<a href="${escape(news)}" style="color:#285b88;font-weight:700;text-decoration:underline;">View all AQ in the News</a><br>${anchor(links.manage_url,'Manage preferences')} &nbsp;&nbsp;·&nbsp;&nbsp; ${anchor(links.unsubscribe_url,'Unsubscribe')}`;
  return {kind,...links,text:`AQ in the News\n${daily?`${label}\n`:''}\n${text}\n\nView all AQ in the News: ${news}\n\nManage preferences: ${links.manage_url}\nUnsubscribe: ${links.unsubscribe_url}\n\n${brandFooterText(site)}\n`,
    html:shell(site,daily?'Your daily selection of air quality news from AQ in the News.':'A newly approved air quality article from AQ in the News.',
      `${daily?`<p style="font-size:13px;line-height:1.5;color:#526273;text-transform:uppercase;letter-spacing:1px;margin:0 0 7px;font-weight:700;">Daily update &nbsp;·&nbsp; ${publicationDate(date)}</p><h2 style="font-size:22px;line-height:1.3;letter-spacing:-.3px;margin:0 0 25px;">${articles.length} new ${articles.length===1?'article':'articles'}</h2>`:'<p style="margin:0 0 18px;font-size:13px;color:#526273;font-weight:700;letter-spacing:1px;text-transform:uppercase;">New article</p>'}${articles.map(a=>articleMarkup(a,daily)).join('')}`,footer)};
}
export function confirmationMessage(site:string,link:string):Message {
  return {kind:'confirmation',
    text:`AQ in the News\n\nPlease confirm your email address to activate your requested AQ in the News subscription.\n\n${link}\n\nThis link expires after 24 hours. If you did not request this subscription, ignore this email. No subscription will activate.\n\n${brandFooterText(site)}\n`,
    html:shell(site,'Confirm your AQ in the News subscription. This link expires after 24 hours.',
      `<h1 style="margin:0 0 20px;font-size:26px;line-height:34px;">Confirm your subscription</h1><p style="font-size:16px;line-height:25px;">Please confirm your email address to activate your requested AQ in the News subscription.</p><p style="font-size:16px;line-height:25px;">${anchor(link,'Confirm your AQ in the News subscription')}</p><p style="font-size:16px;line-height:25px;">This link expires after <strong>24 hours</strong>. If you did not request this subscription, ignore this email. No subscription will activate.</p>`,
      anchor(`${site}/news/`,'View all AQ in the News'))};
}
