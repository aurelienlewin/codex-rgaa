import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

async function resolveVnuJar() {
  const envPath = String(process.env.AUDIT_VNU_JAR || '').trim();
  if (envPath) {
    try {
      await access(envPath);
      return envPath;
    } catch {}
  }
  try {
    const mod = await import('vnu-jar');
    const jarPath = mod?.default || mod;
    if (typeof jarPath === 'string' && jarPath) {
      return jarPath;
    }
  } catch {}
  return null;
}

function runJavaValidator({ jarPath, url, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = ['-jar', jarPath, '--format', 'json', '--errors-only', url];
    const child = spawn('java', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('HTML validator timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk || '');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !out.trim()) {
        reject(new Error(`HTML validator failed: ${err.trim() || `code ${code}`}`));
        return;
      }
      resolve(out);
    });
  });
}

export async function validateHtmlUrl(url, { timeoutMs = 25000 } = {}) {
  const jarPath = await resolveVnuJar();
  if (!jarPath) {
    return { ok: false, error: 'HTML validator not available (missing vnu jar).' };
  }
  try {
    const output = await runJavaValidator({ jarPath, url, timeoutMs });
    const parsed = JSON.parse(output);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const errors = messages.filter((m) => m?.type === 'error');
    const samples = errors
      .slice(0, 3)
      .map((m) => {
        const loc = [m?.lastLine, m?.lastColumn].filter(Boolean).join(':');
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
