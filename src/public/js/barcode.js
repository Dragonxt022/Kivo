/** Validação de código de barras (Kivo) — cópia client-side de shared/barcode (sem bundler). */
window.validateBarcodeClient = function (code) {
  const raw = String(code || '').trim();
  const digits = raw.replace(/\D/g, '');
  const looksLikeEanUpc = /^\d{8}$|^\d{12}$|^\d{13}$/.test(raw);
  if (!looksLikeEanUpc) return true;

  function checkDigit(payload) {
    let sum = 0;
    for (let i = 0; i < payload.length; i++) {
      const weight = (payload.length - i) % 2 === 0 ? 1 : 3;
      sum += Number(payload[i]) * weight;
    }
    return String((10 - (sum % 10)) % 10);
  }

  if (digits.length === 13) return checkDigit(digits.slice(0, 12)) === digits[12];
  if (digits.length === 12) return checkDigit('0' + digits.slice(0, 11)) === digits[11];
  return checkDigit(digits.slice(0, 7)) === digits[7]; // EAN-8
};
