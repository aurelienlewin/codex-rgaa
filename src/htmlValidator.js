import { HtmlValidate } from 'html-validate';

export async function validateHtmlUrl(url, { timeoutMs = 25000 } = {}) {
  try {
    const htmlvalidate = new HtmlValidate({
      extends: ['html-validate:recommended'],
      rules: {
        'no-dup-id': 'error',
        'no-raw-characters': 'error'
      }
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      return { ok: false, error: `HTML fetch failed: ${res.status} ${res.statusText}` };
    }
    const html = await res.text();
    const report = htmlvalidate.validateString(html);
    const errors = (report?.results || [])
      .flatMap((r) => r.messages || [])
      .filter((m) => m.severity === 2);
    const samples = errors
      .slice(0, 3)
      .map((m) => {
        const loc = [m?.line, m?.column].filter(Boolean).join(':');
        const msg = String(m?.message || '').replace(/\s+/g, ' ').trim();
        return loc ? `${loc} ${msg}` : msg;
      })
      .filter(Boolean);
    return {
      ok: true,
      errorsCount: errors.length,
      samples
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
