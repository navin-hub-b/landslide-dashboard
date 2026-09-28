import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSLATIONS,
  ENGLISH_BASELINE,
  getTranslations,
  getTranslation,
} from '../server/modules/translations.js';

describe('Warning-Sign Translations Module (server/modules/translations.js)', () => {
  const expectedLanguages = [
    'Hindi',
    'Bengali',
    'Marathi',
    'Telugu',
    'Tamil',
    'Gujarati',
    'Urdu',
    'Kannada',
    'Odia',
    'Malayalam',
    'Assamese',
    'Nepali',
    'Manipuri (Meitei)',
    'Mizo',
    'Khasi',
    'Garo',
    'Bodo',
    'Kokborok',
    'Nagamese',
  ];

  test('exports all 19 requested regional languages', () => {
    assert.equal(TRANSLATIONS.length, 19);

    const actualNames = TRANSLATIONS.map((t) => t.name);
    for (const expected of expectedLanguages) {
      assert.ok(
        actualNames.includes(expected),
        `Missing requested language: ${expected}`
      );
    }
  });

  test('each language contains all required structural properties', () => {
    for (const item of TRANSLATIONS) {
      assert.ok(item.code, `Missing code in ${item.name}`);
      assert.ok(item.name, `Missing name in ${item.code}`);
      assert.ok(item.nativeName, `Missing nativeName in ${item.name}`);
      assert.ok(item.script, `Missing script in ${item.name}`);
      assert.ok(['ltr', 'rtl'].includes(item.dir), `Invalid dir in ${item.name}`);
      assert.ok(item.translation && item.translation.length > 0, `Missing translation in ${item.name}`);
      assert.ok(['high', 'medium', 'low'].includes(item.confidence), `Invalid confidence in ${item.name}`);
      assert.equal(typeof item.needsVerification, 'boolean', `needsVerification must be boolean in ${item.name}`);
    }
  });

  test('Urdu is explicitly marked with dir: "rtl"', () => {
    const urdu = TRANSLATIONS.find((t) => t.code === 'ur');
    assert.ok(urdu);
    assert.equal(urdu.dir, 'rtl');
    assert.equal(urdu.name, 'Urdu');
    assert.equal(urdu.nativeName, 'اردو');
  });

  test('every non-high-confidence entry is flagged needsVerification', () => {
    for (const item of TRANSLATIONS) {
      if (item.confidence !== 'high') {
        assert.equal(
          item.needsVerification,
          true,
          `Language ${item.name} with confidence "${item.confidence}" must have needsVerification: true`
        );
      }
    }
  });

  test('indicates lower confidence or needsVerification for indigenous and dialectical languages', () => {
    const kokborok = TRANSLATIONS.find((t) => t.code === 'trp');
    assert.ok(kokborok);
    assert.equal(kokborok.needsVerification, true);
    assert.equal(kokborok.confidence, 'low');

    const nagamese = TRANSLATIONS.find((t) => t.code === 'nag');
    assert.ok(nagamese);
    assert.equal(nagamese.needsVerification, true);
    assert.equal(nagamese.confidence, 'low');

    const mizo = TRANSLATIONS.find((t) => t.code === 'lus');
    assert.ok(mizo);
    assert.equal(mizo.needsVerification, true);
  });

  test('getTranslations({ includeEnglish: true }) prepends English baseline', () => {
    const withEn = getTranslations({ includeEnglish: true });
    assert.equal(withEn.length, 20);
    assert.equal(withEn[0].code, 'en');

    const withoutEn = getTranslations();
    assert.equal(withoutEn.length, 19);
  });

  test('getTranslation() looks up language by code or name', () => {
    const hindi = getTranslation('hi');
    assert.ok(hindi);
    assert.equal(hindi.name, 'Hindi');

    const marathi = getTranslation('Marathi');
    assert.ok(marathi);
    assert.equal(marathi.code, 'mr');

    const english = getTranslation('en');
    assert.ok(english);
    assert.equal(english.name, 'English');

    const missing = getTranslation('nonexistent');
    assert.equal(missing, null);
  });
});
