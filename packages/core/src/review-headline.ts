// Diagnostic version 1. Only the original publisher headline is an input.
const strongCue = /(?<![\p{L}\p{M}\p{N}_])(?:air (?:quality|pollution)|pm ?(?:2\.5|10)|no2|nitrogen dioxide|particulate pollution|smog|(?:wood|wildfire) smoke)(?![\p{L}\p{M}\p{N}_])/iu;

export function reviewHeadlineClass(title: string): 'clear' | 'ambiguous' {
  const normalised = title.normalize('NFKC').replace(/[\s\p{Pd}]+/gu, ' ');
  return strongCue.test(normalised) ? 'clear' : 'ambiguous';
}
