import type { DeterministicRelevanceFilter, RelevanceInput } from '@uk-aq-media/core';

function searchableText(input: RelevanceInput): string {
  let urlPath = input.canonical_url;
  try { urlPath = decodeURIComponent(new URL(input.canonical_url).pathname); } catch { /* validated later */ }
  return [input.title, urlPath, ...input.categories].join(' ').normalize('NFKC')
    .toLocaleLowerCase('en-GB').replace(/[\u2010-\u2015/_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function matchesAny(value: string, expressions: RegExp[]): boolean {
  return expressions.some(expression => expression.test(value));
}

const airPollution = [
  /\bair pollution\b/, /\bair quality\b/, /\bindoor air\b/, /\batmospheric pollution\b/,
  /\bparticulate (?:matter|pollution)\b/, /\bpm\s?(?:2\.5|10)\b/,
  /\bnitrogen dioxide\b/, /\bno2\b/, /\bnitrogen oxides?\b/, /\bnox\b/,
  /\bground level ozone\b/, /\bozone (?:air )?pollution\b/, /\bsmog\b/,
  /\bsulphur dioxide\b/, /\bsulfur dioxide\b/,
];

const woodBurning = [
  /\bwood burning\b/, /\bwood burners?\b/, /\blog burners?\b/,
  /\bwood burning stoves?\b/, /\bwood stoves?\b/, /\bdomestic wood burning\b/,
];

// Research-news headlines often describe measured sources without saying "air quality".
// Keep ambiguous scientific terms context-gated rather than accepting all biomass research.
const researchSmoke = /\b(?:wood|biomass|solid fuel) smoke\b/;
const researchCombustion = /\b(?:biomass|residential wood|domestic wood|household solid fuel) (?:burning|combustion)\b/;

const researchSourceAttribution = [
  /\bsource apportionment\b/, /\b(?:air )?pollution fingerprint\b/,
  /\b(?:particulate|aerosol) (?:sources?|fingerprints?)\b/,
  /\b(?:levoglucosan|black carbon|soot|ultrafine particles?|secondary aerosols?)\b/,
];

const wildfire = [
  /\bwildfires?\b/, /\bwildland fires?\b/, /\bbushfires?\b/,
];

const cleanAirPolicy = [
  /\bclean air zones?\b/, /\bultra low emission zones?\b/, /\bulez\b/,
  /\bsmoke control areas?\b/, /\bclean air act\b/,
];

const airContext = /\b(?:air|atmospher\w*|pollution|particulate|pm\s?(?:2\.5|10)|no2|nox|smog|ozone|respiratory|lung|asthma)\b/;

export const mediaDeterministicRelevanceFilter: DeterministicRelevanceFilter = {
  evaluate(input: RelevanceInput): { relevant: boolean; reason: string } {
    const value = searchableText(input);
    if (matchesAny(value, airPollution)) return { relevant: true, reason: 'air_pollution_or_quality' };
    if (matchesAny(value, woodBurning)) return { relevant: true, reason: 'wood_burning' };
    if (researchSmoke.test(value) || researchCombustion.test(value) && airContext.test(value)) {
      return { relevant: true, reason: 'research_smoke_or_biomass' };
    }
    if (matchesAny(value, researchSourceAttribution) && airContext.test(value)) {
      return { relevant: true, reason: 'research_air_source_attribution' };
    }
    if (matchesAny(value, wildfire)) return { relevant: true, reason: 'wildfire' };
    if (matchesAny(value, cleanAirPolicy)) return { relevant: true, reason: 'clean_air_policy' };

    if (/\b(?:moorland|forest|grass|vegetation) fires?\b|\bprescribed burns?\b/.test(value) &&
        /\b(?:smoke|air|pollution|health|emission\w*)\b/.test(value)) {
      return { relevant: true, reason: 'landscape_fire_air_context' };
    }
    if (/\b(?:traffic|road|vehicle|diesel|transport) emissions?\b/.test(value)) {
      return { relevant: true, reason: 'transport_air_emissions' };
    }
    if (/\b(?:shipping|ship|aviation|aircraft|airport) emissions?\b/.test(value) &&
        airContext.test(value)) {
      return { relevant: true, reason: 'transport_air_emissions' };
    }
    if (/\b(?:domestic combustion|solid fuel|ecodesign|defra exempt stove|ready to burn|hetas|stove industry association|charnwood)\b/.test(value) &&
        airContext.test(value)) {
      return { relevant: true, reason: 'domestic_combustion_air_context' };
    }
    if (/\b(?:air|pollution) monitor(?:ing|s)?\b|\blow cost (?:air )?sensors?\b/.test(value) &&
        airContext.test(value)) {
      return { relevant: true, reason: 'air_monitoring' };
    }
    if (/\b(?:atmospheric chemistry|aerosol pollution|airborne pollution)\b/.test(value)) {
      return { relevant: true, reason: 'atmospheric_pollution' };
    }
    return { relevant: false, reason: 'no_deterministic_aq_match' };
  },
};
