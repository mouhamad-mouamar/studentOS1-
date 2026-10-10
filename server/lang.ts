// Response-language matching: infer the student's language from their latest
// message (Arabic script, Lebanese Arabizi, French, English, mixed) and turn
// it into an explicit prompt instruction. Detection is heuristic and
// conservative — when in doubt we fall back to English and never force
// Arabic: any language the model can produce is allowed through an explicit
// "reply in the language of the message" fallback rule.

export interface LangMatch {
  code: 'ar' | 'en' | 'fr';
  rule: string;
}

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

// Lebanese/Levantine Arabizi in Latin script. Digits-as-letters (2=hamza,
// 3=ayn, 7=ha) are a strong signal; the word list covers common function
// words so plain transliterations without digits still match.
const ARABIZI_WORDS = new Set(
  `fik fikra fikye ta3me ta3melo ta3melle te3me te3melo te3melle tene te2der
   lakhasli lakhhasli la2hasli malakhiz malkhzeh 3mello 3mela 3mel 3andi
   3arabi 3arabe 3an 3addon 3ala 3leb 3indak 3indik shu shi shufo shuf
   kif kifa ktir kteer mni7 mniha yalla wleh khalas khallas shukran Lazem
   lzim baddi baddak bade btdall bte3ref bhebak habibi habibe hayda heik
   heyk hek mnel mnih a3tik a3tini 2ism ism rakez rakiz dars ktabe
   majmoua majmou3a jawless jaweb sou2al so2al mabi3ref mabte3ref mafroud
   malforef bel3arabi bel2arabi bi3arabi walao wallah akid tayeb enta ente
   ana nehna el e rather lal la2 bel belه bala metel mitl kaza shi ghir
   khususan ya3ni yaani bisaraha wasfi mfassar fasserni yesser kalousse`
    .split(/\s+/)
    .filter(Boolean),
);

// A Latin word containing a digit used as a letter (ta3melo, se2er, 3andi)
const ARABIZI_DIGIT = /\b[a-z]*[23789][a-z]*\b/i;

const FRENCH_HINTS = new Set(
  'le la les un une des du de et est suis je tu il elle nous vous ils résume résumé résumer résumé peux peux voudrais merci sil plaît stp'.split(' '),
);
const FRENCH_ACCENT = /[àâçéèêëîïôûùüœ]/i;

// Words that are the same in French and English (or too short to be signal)
// are ignored; we require at least one distinctive hint.
function frenchSignal(words: string[]): boolean {
  const hits = words.filter((w) => FRENCH_HINTS.has(w) || FRENCH_ACCENT.test(w)).length;
  return hits >= 1;
}

function arabiziSignal(words: string[]): boolean {
  if (words.some((w) => ARABIZI_DIGIT.test(w))) return true;
  const hits = words.filter((w) => ARABIZI_WORDS.has(w)).length;
  return hits >= 1;
}

export function detectResponseLang(message: string): LangMatch {
  const text = (message || '').trim();

  // Arabic script present → Arabic wins (dominant-script rule for mixed
  // Arabic/English messages; technical terms stay in English via the rule).
  if (ARABIC_SCRIPT.test(text)) {
    return {
      code: 'ar',
      rule:
        'Respond in clear, natural Arabic (Lebanese-flavored Modern Standard Arabic is fine). Keep technical terms, formulas, code and the [1] [2] citation markers in their original form when that is clearer.',
    };
  }

  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  if (arabiziSignal(words)) {
    return {
      code: 'ar',
      rule:
        'The student is writing Lebanese Arabic in Latin script (Arabizi). Respond in Arabic script (clear, natural Arabic, simple Lebanese flavor where it helps), keeping technical terms in English where clearer.',
    };
  }

  if (frenchSignal(words)) {
    return {
      code: 'fr',
      rule:
        'Respond in French. Keep technical terms, formulas and the [1] [2] citation markers in their original form when that is clearer.',
    };
  }

  return {
    code: 'en',
    rule:
      'Respond in the same language the student used in their latest message (default English). If they wrote in another language, mirror it; keep technical terms, formulas and the [1] [2] citation markers intact.',
  };
}

// Strip Arabic diacritics/tatweel so لخّص matches لخص.
function normalizeArabic(text: string): string {
  return text.replace(/[\u064B-\u065F\u0670\u0640]/g, '');
}

const AR_SUMMARY = /ملخص|لخص|تلخيص|اختصر|باختصار/;
const EN_SUMMARY = /\b(summar(y|ise|ize)|recap|tl;?dr|overview of|main (points|ideas|topics))\b/i;
const ARABIZI_SUMMARY = /\b(lakhasli|lakhhasli|la2hasli|malakhiz|malkhzeh|summary|summarize|summarise|recap)\b/i;

/**
 * True when the student's message asks for a course/lecture-level summary
 * rather than a narrow topical question. Arabic script, Lebanese Arabizi and
 * English forms all count. Conservative: "summarize the proof of X" still
 * matches (it IS a summary request), while plain topical questions don't.
 */
export function isSummaryRequest(message: string): boolean {
  const text = normalizeArabic((message || '').toLowerCase());
  if (AR_SUMMARY.test(text)) return true;
  if (EN_SUMMARY.test(text)) return true;
  if (ARABIZI_SUMMARY.test(text)) return true;
  return false;
}

// Prompt fragment appended to generation prompts for UI-triggered features
// (study guide, quiz, analysis) where the student's UI locale is the best
// available signal of their language.
export function uiLocaleRule(lang: unknown): string {
  if (lang === 'ar') {
    return ' Write the generated content in clear, natural Arabic, keeping technical terms, formulas, identifiers and [1] [2] citation markers in their original form when clearer.';
  }
  if (lang === 'fr') {
    return ' Write the generated content in French, keeping technical terms, formulas, identifiers and [1] [2] citation markers in their original form when clearer.';
  }
  return '';
}
