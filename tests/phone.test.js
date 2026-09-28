import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToE164 } from '../server/modules/phone.js';

describe('Phone Number E.164 Normalization (server/modules/phone.js)', () => {
  test('normalizes standard 10-digit number with country code', () => {
    const res = normalizeToE164('91', '9876543210');
    assert.equal(res.valid, true);
    assert.equal(res.e164, '+919876543210');
    assert.equal(res.error, null);
  });

  test('normalizes US/Canada number with country code and formatting', () => {
    const res = normalizeToE164('+1', '(415) 555-0199');
    assert.equal(res.valid, true);
    assert.equal(res.e164, '+14155550199');
    assert.equal(res.error, null);
  });

  test('normalizes already-prefixed E.164 single argument string', () => {
    const res = normalizeToE164('+919876543210');
    assert.equal(res.valid, true);
    assert.equal(res.e164, '+919876543210');
  });

  test('strips leading national trunk zero from national subscriber number', () => {
    const res = normalizeToE164('91', '09876543210');
    assert.equal(res.valid, true);
    assert.equal(res.e164, '+919876543210');
  });

  test('rejects missing or empty country code', () => {
    const res1 = normalizeToE164('', '9876543210');
    assert.equal(res1.valid, false);
    assert.ok(res1.error.includes('Country code is required'));

    const res2 = normalizeToE164(null, '9876543210');
    assert.equal(res2.valid, false);
  });

  test('rejects invalid country code length (> 3 digits or non-digits)', () => {
    const res = normalizeToE164('1234', '9876543210');
    assert.equal(res.valid, false);
    assert.ok(res.error.includes('1 to 3 digits'));
  });

  test('rejects missing or empty subscriber number', () => {
    const res = normalizeToE164('91', '');
    assert.equal(res.valid, false);
    assert.ok(res.error.includes('Subscriber phone number is required'));
  });

  test('rejects subscriber number shorter than 4 digits', () => {
    const res = normalizeToE164('91', '123');
    assert.equal(res.valid, false);
    assert.ok(res.error.includes('between 4 and 14 digits'));
  });

  test('rejects subscriber number longer than 14 digits', () => {
    const res = normalizeToE164('91', '123456789012345');
    assert.equal(res.valid, false);
    assert.ok(res.error.includes('between 4 and 14 digits'));
  });

  test('rejects total E.164 length greater than 15 digits', () => {
    // 3 digit CC + 13 digit subscriber = 16 digits > 15
    const res = normalizeToE164('999', '1234567890123');
    assert.equal(res.valid, false);
    assert.ok(res.error.includes('cannot exceed 15'));
  });
});
