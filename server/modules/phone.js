/**
 * Phone Number E.164 Normalization & Validation Module
 *
 * Implements structural validation for international E.164 telecommunications format:
 * - Country Code: 1 to 3 digits
 * - National Subscriber Number: 4 to 14 digits
 * - Total E.164 Length: max 15 digits (excluding leading '+')
 */

/**
 * Normalizes and validates a phone number into strict E.164 format.
 *
 * @param {string|number} countryCode 1-3 digit country calling code (e.g., '91', '+91', '1')
 * @param {string|number} [rawNumber] 4-14 digit subscriber number (or full number if countryCode is omitted)
 * @returns {{ valid: boolean, e164: string|null, error: string|null }}
 */
export function normalizeToE164(countryCode, rawNumber) {
  // Support flexible argument patterns: normalizeToE164('+919876543210') or normalizeToE164('91', '9876543210')
  let ccInput = countryCode;
  let numInput = rawNumber;

  if (rawNumber === undefined && typeof countryCode === 'string') {
    const trimmed = countryCode.trim();
    if (trimmed.startsWith('+')) {
      // Extract country code heuristically from full number if passed as single arg
      // E.g. +91 9876543210 or +1 415 555 2671
      const digitsOnly = trimmed.slice(1).replace(/\D/g, '');
      if (digitsOnly.length < 5 || digitsOnly.length > 15) {
        return {
          valid: false,
          e164: null,
          error: `Phone number must contain between 5 and 15 digits in total (received ${digitsOnly.length})`,
        };
      }
      return {
        valid: true,
        e164: `+${digitsOnly}`,
        error: null,
      };
    } else {
      return {
        valid: false,
        e164: null,
        error: 'Subscriber number is required when country code is provided separately',
      };
    }
  }

  if (ccInput === null || ccInput === undefined || String(ccInput).trim() === '') {
    return {
      valid: false,
      e164: null,
      error: 'Country code is required (1 to 3 digits)',
    };
  }

  if (numInput === null || numInput === undefined || String(numInput).trim() === '') {
    return {
      valid: false,
      e164: null,
      error: 'Subscriber phone number is required (4 to 14 digits)',
    };
  }

  // Sanitize country code: strip leading '+', spaces, dashes
  const cleanCC = String(ccInput).trim().replace(/^\+/, '').replace(/\D/g, '');
  if (cleanCC.length < 1 || cleanCC.length > 3) {
    return {
      valid: false,
      e164: null,
      error: `Country code must be 1 to 3 digits (received '${ccInput}' -> ${cleanCC.length} digits)`,
    };
  }

  // Sanitize subscriber number: strip leading trunk '0' if present, spaces, parentheses, dashes
  let cleanNum = String(numInput).trim().replace(/\D/g, '');

  // Strip leading national trunk 0 (e.g. 09876543210 -> 9876543210) if subscriber length exceeds 10
  if (cleanNum.startsWith('0') && cleanNum.length > 10) {
    cleanNum = cleanNum.replace(/^0+/, '');
  }

  if (cleanNum.length < 4 || cleanNum.length > 14) {
    return {
      valid: false,
      e164: null,
      error: `Subscriber number must be between 4 and 14 digits (received '${numInput}' -> ${cleanNum.length} digits)`,
    };
  }

  const totalLength = cleanCC.length + cleanNum.length;
  if (totalLength > 15) {
    return {
      valid: false,
      e164: null,
      error: `Total E.164 digits cannot exceed 15 (country code ${cleanCC.length} + subscriber ${cleanNum.length} = ${totalLength})`,
    };
  }

  const e164 = `+${cleanCC}${cleanNum}`;

  return {
    valid: true,
    e164,
    error: null,
  };
}

export default { normalizeToE164 };
