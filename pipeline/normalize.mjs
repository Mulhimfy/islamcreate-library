// Search normalisation for the library, shared by the index build and the
// browser (the site copies this file verbatim). Every token in the index
// went through tokens(); a query must go through the same function or it
// will not find them. Changing anything here means rebuilding the index:
// bump NORM_VERSION so a stale client can tell.
export const NORM_VERSION = 1;

// Honorific ligatures are single code points in the books; a reader types
// the words. Unicode gives the older ones a compatibility decomposition but
// not the U+FD40 block, so all are spelled out here.
const LIGATURES = {
  '﵀': 'رحمه الله',
  '﵁': 'رضي الله عنه',
  '﵂': 'رضي الله عنها',
  '﵃': 'رضي الله عنهم',
  '﵄': 'رضي الله عنهما',
  '﵅': 'رضي الله عنهن',
  '﵆': 'صلى الله عليه وآله',
  '﵇': 'عليه السلام',
  '﵈': 'عليهم السلام',
  '﵉': 'عليهما السلام',
  '﵊': 'عليه الصلاة والسلام',
  '﵋': 'قدس سره',
  '﵌': 'صلى الله عليه وآله وسلم',
  '﵍': 'عليها السلام',
  '﵎': 'تبارك وتعالى',
  '﵏': 'رحمهم الله',
  '﷏': 'سلامه علينا',
  'ﷲ': 'الله',
  'ﷳ': 'اكبر',
  'ﷴ': 'محمد',
  'ﷶ': 'رسول',
  'ﷷ': 'عليه',
  'ﷸ': 'وسلم',
  'ﷹ': 'صلى',
  'ﷺ': 'صلى الله عليه وسلم',
  'ﷻ': 'جل جلاله',
  '﷽': 'بسم الله الرحمن الرحيم',
  '﷾': 'سبحانه وتعالى',
  '﷿': 'عز وجل',
};
const LIGATURE_RE = /[﵀-﵏﷏ﷲ-﷿]/g;

/** The honorific ligatures spelled out, for formats without a font that draws them. */
export const spellHonorifics = (text) => text.replace(/[\uFD40-\uFD4F\uFDCF\uFDFE\uFDFF]/g, (c) => ` (${LIGATURES[c]}) `);
// Presentation forms (old encodings, PDFs) fold to the letters they draw.
const PRESENTATION_RE = /[ﭐ-ﴽﵐ-﷎ﷰﷱﹰ-﻿]+/g;
// Harakat, tanwin, shadda, sukun, superscript alef, Quranic marks, tatweel.
const MARKS_RE = /[ؐ-ًؚ-ٰٟۖ-ۭـ࣓-ࣿ]/g;
const UNIFY = {
  'آ': 'ا', 'أ': 'ا', 'إ': 'ا', 'ٱ': 'ا',
  'ى': 'ي', 'ئ': 'ي', 'ی': 'ي', 'ې': 'ي',
  'ؤ': 'و',
  'ة': 'ه', 'ۀ': 'ه', 'ہ': 'ه', 'ە': 'ه',
  'ک': 'ك',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};
const UNIFY_RE = /[آأإٱىئیېؤةۀہەک٠-٩۰-۹]/g;
const TOKEN_RE = /[ء-غف-يٱ-ۓۺ-ۿa-z0-9ß-ÿ]{2,}/g;

/** The searchable form of a text: one space between words, nothing else. */
export function normalize(text) {
  return text
    .replace(LIGATURE_RE, (c) => ` ${LIGATURES[c]} `)
    .replace(PRESENTATION_RE, (s) => s.normalize('NFKC'))
    .replace(MARKS_RE, '')
    .replace(UNIFY_RE, (c) => UNIFY[c])
    .toLowerCase();
}

/** A word as written, without harakat or tatweel: how a reader spells it. */
export const plain = (word) => word.replace(MARKS_RE, '');

/** Index terms of a text, in order, repeats kept. Single letters are not terms. */
export function tokens(text) {
  return normalize(text).match(TOKEN_RE) || [];
}

// Clitics a reader leaves off: the conjunctions, the attached prepositions
// and the article. Every form a word takes with them shares one dictionary
// bucket, so "صلاه" fetches "الصلاه", "بالصلاه" and "والصلاه" with it.
const CLITICS = ['ال', 'و', 'ف', 'ب', 'ك', 'ل'];

/**
 * The bucket key of a term: leading clitics stripped greedily while two
 * letters remain. key(p + w) === key(w) for any chain of clitics p, which
 * is what lets one bucket answer a broad query.
 */
export function stemKey(term) {
  let w = term;
  for (;;) {
    const c = CLITICS.find((p) => w.startsWith(p) && w.length - p.length >= 2);
    if (!c) return w;
    w = w.slice(c.length);
  }
}

// Prefix chains accepted in a broad match, longest first.
export const PREFIXES = ['وبال', 'وكال', 'فبال', 'فكال', 'ولل', 'فلل', 'وال', 'فال', 'بال', 'كال', 'لل', 'وب', 'وك', 'ول', 'فب', 'فك', 'فل', 'ال', 'و', 'ف', 'ب', 'ك', 'ل', ''];

/** The core a broad match grows prefixes onto: the term without its article. */
export function broadCore(term) {
  return term.startsWith('ال') && term.length > 3 ? term.slice(2) : term;
}

/** Whether `form` is `core` with a clitic chain in front (or core itself). */
export function isBroadForm(form, core) {
  if (!form.endsWith(core)) return false;
  const head = form.slice(0, form.length - core.length);
  // "لل" + core stands for ل + ال + core with the alef dropped.
  return PREFIXES.includes(head);
}

/** FNV-1a over UTF-16 code units: cheap, identical in Node and browsers. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const bucketOf = (term, buckets) => hash32(stemKey(term)) % buckets;

/**
 * Which keyword file completes a term: the first two letters of the term
 * without its article, so "الصلا" and "صلا" look in the same place.
 */
export function completionKey(term) {
  const core = term.startsWith('ال') && term.length > 3 ? term.slice(2) : term;
  return [...core.slice(0, 2)].map((c) => c.codePointAt(0).toString(16)).join('-');
}
