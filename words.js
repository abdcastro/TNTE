'use strict';

// Words that should NEVER animate: common function words (articles, pronouns,
// prepositions, conjunctions, auxiliaries, discourse filler...). Nothing
// meaningful would "happen" to "the" or "and", and animating every connective
// word would turn ordinary prose into chaos. These resolve to a shared no-op
// (the word stays plain text) and never reach Claude.
//
// Note: this deliberately includes spatial prepositions like "up"/"down"/"over"
// because they are overwhelmingly used as grammatical connectives. If you'd
// rather those animate, just remove them from this set.
const STOPWORDS = new Set([
  // articles / determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'either',
  'neither', 'some', 'any', 'all', 'both', 'few', 'more', 'most', 'much', 'many',
  'other', 'another', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  // pronouns
  'i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'ours', 'ourselves',
  'you', 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
  'theirs', 'themselves', 'who', 'whom', 'whose', 'which', 'what', 'whatever',
  'whoever', 'whomever', 'whichever', 'one', 'ones', 'someone', 'anyone',
  'everyone', 'something', 'anything', 'everything', 'nothing', 'somebody',
  'anybody', 'everybody', 'nobody', 'none',
  // prepositions
  'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'against', 'between',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from',
    'off', 'again', 'further', 'then', 'once',
  'here', 'there', 'near', 'onto', 'upon', 'per', 'via', 'than', 'as', 'toward',
  'towards', 'within', 'without', 'across', 'along', 'among', 'around', 'behind',
  'beside', 'beyond', 'inside', 'outside',
  // conjunctions / connectives
  'and', 'but', 'or', 'yet', 'because', 'although', 'though', 'while', 'if',
  'unless', 'until', 'whether', 'since', 'whereas', 'however', 'therefore',
  'thus', 'hence', 'moreover', 'otherwise', 'also', 'plus', 'else', 'instead',
  'anyway', 'meanwhile', 'nevertheless', 'nonetheless',
  // auxiliary / very common verbs
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'having', 'do', 'does', 'did', 'doing', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'ought', 'need', 'let', 'get', 'got',
  // adverbs / filler / discourse
  'very', 'too', 'just', 'even', 'still', 'quite', 'rather', 'almost', 'always',
  'never', 'often', 'sometimes', 'usually', 'really', 'actually', 'maybe',
  'perhaps', 'well', 'now', 'soon', 'already', 'ever', 'somewhat', 'somehow',
  'like', 'okay', 'ok', 'yes', 'yeah', 'oh', 'um', 'uh', 'er', 'hmm',
  // question / relative
  'how', 'why', 'when', 'where', 'whenever', 'wherever',
]);

// Cheap, deterministic pre-filter for the MOST obvious keyboard-mash gibberish,
// so it never costs a Claude call. Kept deliberately conservative to avoid
// rejecting real words (English has sparse-vowel words like "strengths" and
// "rhythms"); anything subtler — pronounceable non-words like "aduvnirfudjaifj"
// — is left for Claude to refuse.
function looksLikeGibberish(word) {
  const w = word.toLowerCase();
  const vowels = (w.match(/[aeiouy]/g) || []).length;
  // A 5+ letter token with no vowel at all is not a pronounceable word.
  if (vowels === 0 && w.length >= 5) return true;
  // A run of 6+ consonants is beyond what real English words use.
  if (/[^aeiouy]{6,}/.test(w)) return true;
  return false;
}

module.exports = { STOPWORDS, looksLikeGibberish };
