const localPart = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/;
const domainPart = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// V1 intentionally supports only the ASCII dot-atom/DNS form accepted by the
// production SMTP serializer. Normalisation is lower(btrim(email)); no
// provider-specific dot or plus-tag rewriting is permitted.
export function normalizeSupportedMailbox(value:unknown):string|null {
  if(typeof value!=='string') return null;
  const trimmed=value.replace(/^ +| +$/g,'');
  // Reject before case folding: some Unicode characters (for example the Kelvin
  // sign) lowercase to ASCII and would otherwise change the destination mailbox.
  if(/[^\x00-\x7f]/.test(trimmed)) return null;
  const email=trimmed.toLowerCase();
  const parts=email.split('@');
  if(parts.length!==2 || email.length<3 || email.length>254) return null;
  const [local,domain]=parts;
  if(!local || local.length>64 || !domain || !localPart.test(local) || !domainPart.test(domain)) return null;
  if(domain.split('.').some(label=>label.length>63)) return null;
  return email;
}
