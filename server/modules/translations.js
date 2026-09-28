/**
 * Multi-Language Warning-Sign Translations Module
 *
 * Exports 19 regional Indian language translations for emergency landslide warning signage:
 * "LANDSLIDE DANGER — EVACUATE NOW"
 *
 * Essential for life-safety communication across vulnerable mountainous and hilly terrain
 * in the Western Ghats, Himalayas, and North-Eastern hill states.
 *
 * Each entry provides:
 * - code: ISO 639-1 / ISO 639-3 language code
 * - name: English name of the language
 * - nativeName: Language name in its native script
 * - script: Writing script system
 * - dir: Text direction ('ltr' or 'rtl')
 * - translation: Concise equivalent of "LANDSLIDE DANGER — EVACUATE NOW" in native script
 * - confidence: Translation confidence rating ('high', 'medium', 'low')
 * - needsVerification: True if field-testing or local dialect verification is advised
 */

export const ENGLISH_BASELINE = {
  code: 'en',
  name: 'English',
  nativeName: 'English',
  script: 'Latin',
  dir: 'ltr',
  translation: 'LANDSLIDE DANGER — EVACUATE NOW',
  confidence: 'high',
  needsVerification: false,
};

export const TRANSLATIONS = [
  {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    script: 'Devanagari',
    dir: 'ltr',
    translation: 'भूस्खलन का खतरा — तुरंत सुरक्षित स्थान पर जाएं',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'bn',
    name: 'Bengali',
    nativeName: 'বাংলা',
    script: 'Bengali',
    dir: 'ltr',
    translation: 'ভূমিধসের বিপদ — অবিলম্বে এলাকা খালি করুন',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'mr',
    name: 'Marathi',
    nativeName: 'मराठी',
    script: 'Devanagari',
    dir: 'ltr',
    translation: 'दरड कोसळण्याचा धोका — त्वरित सुरक्षित स्थळी जा',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'te',
    name: 'Telugu',
    nativeName: 'తెలుగు',
    script: 'Telugu',
    dir: 'ltr',
    translation: 'కొండచరియలు విరిగిపడే ప్రమాదం — వెంటనే ఖాళీ చేయండి',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'ta',
    name: 'Tamil',
    nativeName: 'தமிழ்',
    script: 'Tamil',
    dir: 'ltr',
    translation: 'நிலச்சரிவு அபாயம் — உடனே வெளியேறவும்',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'gu',
    name: 'Gujarati',
    nativeName: 'ગુજરાતી',
    script: 'Gujarati',
    dir: 'ltr',
    translation: 'ભૂસ્ખલનનો ભય — તરત જ ખાલી કરો',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'ur',
    name: 'Urdu',
    nativeName: 'اردو',
    script: 'Nastaliq / Arabic',
    dir: 'rtl',
    translation: 'لینڈ سلائیڈنگ کا خطرہ — فوراً محفوظ مقام پر منتقل ہوں',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'kn',
    name: 'Kannada',
    nativeName: 'ಕನ್ನಡ',
    script: 'Kannada',
    dir: 'ltr',
    translation: 'ಭೂಕುಸಿತದ ಅಪಾಯ — ತಕ್ಷಣ ತೆರವುಗೊಳಿಸಿ',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'or',
    name: 'Odia',
    nativeName: 'ଓଡ଼ିଆ',
    script: 'Odia',
    dir: 'ltr',
    translation: 'ଭୂସ୍ଖଳନ ବିପଦ — ତୁରନ୍ତ ସ୍ଥାନ ଖାଲି କରନ୍ତୁ',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'ml',
    name: 'Malayalam',
    nativeName: 'മലയാളം',
    script: 'Malayalam',
    dir: 'ltr',
    translation: 'ഉരുൾപൊട്ടൽ ഭീഷണി — ഉടൻ ഒഴിഞ്ഞുപോകുക',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'as',
    name: 'Assamese',
    nativeName: 'অসমীয়া',
    script: 'Bengali-Assamese',
    dir: 'ltr',
    translation: 'ভূমিস্খলনৰ বিপদ — তৎক্ষণাত স্থান ত্যাগ কৰক',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'ne',
    name: 'Nepali',
    nativeName: 'नेपाली',
    script: 'Devanagari',
    dir: 'ltr',
    translation: 'पहिरोको जोखिम — तुरुन्त सुरक्षित ठाउँमा जानुहोस्',
    confidence: 'high',
    needsVerification: false,
  },
  {
    code: 'mni',
    name: 'Manipuri (Meitei)',
    nativeName: 'ꯃꯩꯇꯩꯂꯣꯟ',
    script: 'Meitei Mayek',
    dir: 'ltr',
    translation: 'ꯂꯩ ꯆꯥꯏꯕꯒꯤ ꯑꯀꯤꯕ — ꯍꯧꯖꯤꯛꯃꯛ ꯃꯐꯝ ꯊꯥꯗꯣꯛꯎ',
    confidence: 'medium',
    needsVerification: true,
  },
  {
    code: 'lus',
    name: 'Mizo',
    nativeName: 'Mizo ṭawng',
    script: 'Latin',
    dir: 'ltr',
    translation: 'Leimin hlauhawm — Chhuak nghal rawh u',
    confidence: 'medium',
    needsVerification: true,
  },
  {
    code: 'kha',
    name: 'Khasi',
    nativeName: 'Ka Ktien Khasi',
    script: 'Latin',
    dir: 'ltr',
    translation: 'Ka jingma na ka twa khyndew — Phet mardor sha ka jaka ba shngain',
    confidence: 'medium',
    needsVerification: true,
  },
  {
    code: 'grt',
    name: 'Garo',
    nativeName: 'A·chik',
    script: 'Latin',
    dir: 'ltr',
    translation: 'A·a be·ani kenani — Da·on safe biapona katbo',
    confidence: 'medium',
    needsVerification: true,
  },
  {
    code: 'brx',
    name: 'Bodo',
    nativeName: 'बर’',
    script: 'Devanagari',
    dir: 'ltr',
    translation: 'हा बानायनायनि खौरां — थाबैनो जायगा गार',
    confidence: 'medium',
    needsVerification: true,
  },
  {
    code: 'trp',
    name: 'Kokborok',
    nativeName: 'Kokborok',
    script: 'Latin',
    dir: 'ltr',
    translation: 'Haste kubui buphang — Takhukno thani jakno turok di',
    confidence: 'low',
    needsVerification: true,
  },
  {
    code: 'nag',
    name: 'Nagamese',
    nativeName: 'Nagamese',
    script: 'Latin',
    dir: 'ltr',
    translation: 'Mati guli jowa khatra — Itia hi safe jagat jabi',
    confidence: 'low',
    needsVerification: true,
  },
];

/**
 * Returns all 19 warning translations, optionally prepending English baseline.
 *
 * @param {Object} [options]
 * @param {boolean} [options.includeEnglish=false] Include English baseline at index 0
 * @returns {Array<Object>}
 */
export function getTranslations(options = {}) {
  if (options.includeEnglish) {
    return [ENGLISH_BASELINE, ...TRANSLATIONS];
  }
  return [...TRANSLATIONS];
}

/**
 * Finds a translation by code or language name.
 *
 * @param {string} codeOrName Language code (e.g., 'hi') or name (e.g., 'Hindi')
 * @returns {Object|null}
 */
export function getTranslation(codeOrName) {
  if (!codeOrName || typeof codeOrName !== 'string') return null;
  const q = codeOrName.trim().toLowerCase();

  if (q === 'en' || q === 'english') {
    return { ...ENGLISH_BASELINE };
  }

  return (
    TRANSLATIONS.find(
      (t) =>
        t.code.toLowerCase() === q ||
        t.name.toLowerCase() === q ||
        t.nativeName.toLowerCase() === q
    ) || null
  );
}

export default {
  TRANSLATIONS,
  ENGLISH_BASELINE,
  getTranslations,
  getTranslation,
};
