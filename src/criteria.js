import fs from 'node:fs';
import path from 'node:path';
import { normalizeReportLang } from './i18n.js';

const DEFAULT_CRITERIA_PATH = path.resolve('data/rgaa-criteria.json');
const EN_CRITERIA_PATH = path.resolve('data/rgaa-criteria.en.json');

export function loadCriteria(options = {}) {
  const lang = normalizeReportLang(options.lang);
  const criteriaPath = options.path
    ? path.resolve(String(options.path))
    : lang === 'en'
      ? EN_CRITERIA_PATH
      : DEFAULT_CRITERIA_PATH;

  if (!fs.existsSync(criteriaPath)) {
    throw new Error(`Missing criteria file: ${criteriaPath}`);
  }
  const data = JSON.parse(fs.readFileSync(criteriaPath, 'utf-8'));
  return data.criteria || [];
}
