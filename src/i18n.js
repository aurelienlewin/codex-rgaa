export function normalizeReportLang(lang) {
  const value = String(lang || '').trim().toLowerCase();
  return value === 'en' ? 'en' : 'fr';
}

const STATUS_LABELS = {
  fr: {
    Conform: 'Conforme',
    'Not conform': 'Non conforme',
    'Non applicable': 'Non applicable',
    Error: 'Erreur',
    'AI review': 'Revue IA'
  },
  en: {
    Conform: 'Conform',
    'Not conform': 'Not conform',
    'Non applicable': 'Non applicable',
    Error: 'Error',
    'AI review': 'AI review'
  }
};

export function getI18n(lang) {
  const reportLang = normalizeReportLang(lang);

  const t = (fr, en) => (reportLang === 'en' ? en : fr);
  const statusLabel = (status) =>
    STATUS_LABELS[reportLang][String(status || '')] || String(status || '');

  return {
    lang: reportLang,
    t,
    statusLabel,
    excel: {
      matrixHeader: () => [t('ID', 'ID'), t('Thème', 'Theme'), t('Critère', 'Criterion')],
      urlLabel: () => t('URL', 'URL'),
      summaryTitle: () => t('Synthèse audit RGAA', 'RGAA Audit Summary'),
      generatedAt: () => t('Généré le', 'Generated at'),
      pagesAudited: () => t('Pages auditées', 'Pages audited'),
      globalScore: () => t('Score global (C / (C+NC))', 'Global score (C / (C+NC))'),
      pagesFailed: () => t('Pages en échec', 'Pages failed'),
      aiFailures: () => t('Échecs IA', 'AI failures'),
      globalStatus: () => t('Statut global des critères', 'Global criteria status'),
      conform: () => t('Conforme (C)', 'Conform (C)'),
      notConform: () => t('Non conforme (NC)', 'Not conform (NC)'),
      nonApplicable: () => t('Non applicable (NA)', 'Non applicable (NA)'),
      errors: () => t('Erreurs (ERR)', 'Errors (ERR)')
    },
    notes: {
      examplesLabel: () => t('Exemples :', 'Examples:'),
      aiPrefix: (confidence) =>
        t(
          `IA (${Number(confidence || 0).toFixed(2)})`,
          `AI (${Number(confidence || 0).toFixed(2)})`
        ),
      aiReviewLabel: () => t('Revue IA', 'AI review'),
      aiFailed: () => t('Revue IA échouée', 'AI review failed')
    }
  };
}

