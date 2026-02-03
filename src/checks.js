import { getI18n, normalizeReportLang } from './i18n.js';

export const STATUS = {
  C: 'Conform',
  NC: 'Not conform',
  NA: 'Non applicable',
  ERR: 'Error',
  AI: 'Review'
};

const GENERIC_LINK_TEXTS = new Set([
  'cliquez ici',
  'ici',
  'lire la suite',
  'lire plus',
  'en savoir plus',
  'plus',
  'voir plus',
  'voir',
  'découvrir',
  'decouvrir',
  'suite',
  'details',
  'détails',
  'accéder',
  'acceder'
]);

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[\u2019'".,:;!?()\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(text, max = 80) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1))}…` : cleaned;
}

function takeExamples(items, formatter, max = 3) {
  const out = [];
  for (const item of items || []) {
    if (out.length >= max) break;
    try {
      const text = formatter(item);
      if (text) out.push(text);
    } catch {}
  }
  return out;
}

function isValidLangCode(lang) {
  if (!lang) return false;
  try {
    const normalized = Intl.getCanonicalLocales(lang);
    return Array.isArray(normalized) && normalized.length > 0;
  } catch (err) {
    return false;
  }
}

function evaluateImagesAlt(snapshot, i18n) {
  const images = snapshot.images || [];
  if (images.length === 0) {
    const visual = snapshot.visual || {};
    const cssBg = Number(visual.cssBackgroundImages || 0);
    const svg = Number(visual.svg || 0);
    const canvas = Number(visual.canvas || 0);
    const picture = Number(visual.picture || 0);

    const hasNonImgVisuals = cssBg > 0 || svg > 0 || canvas > 0 || picture > 0;
    if (hasNonImgVisuals) {
      const parts = [
        cssBg > 0 ? `${cssBg} background-image CSS` : null,
        svg > 0 ? `${svg} <svg>` : null,
        canvas > 0 ? `${canvas} <canvas>` : null,
        picture > 0 ? `${picture} <picture>` : null
      ].filter(Boolean);

      return {
        status: STATUS.AI,
        aiCandidate: true,
        automated: false,
        notes: i18n.t(
          `Aucune balise <img> (ou role="img") détectée, mais des visuels non-<img> existent (${parts.join(
            ', '
          )}). Revue requise pour déterminer si des alternatives textuelles sont nécessaires.`,
          `No <img> (or role="img") found, but non-<img> visuals exist (${parts.join(
            ', '
          )}). Review required to determine whether text alternatives are needed.`
        ),
        examples: Array.isArray(visual.bgExamples) && visual.bgExamples.length
          ? takeExamples(
              visual.bgExamples,
              (ex) =>
                `${ex.tag}${ex.id ? `#${ex.id}` : ''}${ex.className ? `.${String(ex.className).split(/\s+/)[0]}` : ''} backgroundImage=${clipText(ex.backgroundImage, 60)}`,
              3
            )
          : []
      };
    }

    return {
      status: STATUS.NA,
      notes: i18n.t(
        'Aucune balise <img> (ou role="img") détectée dans le DOM.',
        'No <img> or role="img" found in the DOM.'
      )
    };
  }

  const missingAlt = images.filter((img) => img.tag === 'img' && img.alt === null && !img.ariaHidden);
  if (missingAlt.length > 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t(
        `${missingAlt.length} <img> sans attribut alt.`,
        `${missingAlt.length} <img> without alt attribute.`
      ),
      examples: takeExamples(
        missingAlt,
        (img) =>
          `img alt=(missing) aria-hidden=${img.ariaHidden} role=${img.role || '(none)'} name=${clipText(img.name, 40) || '(empty)'}`
      )
    };
  }

  const emptyAlt = images.filter(
    (img) =>
      img.tag === 'img' &&
      img.alt !== null &&
      img.alt.trim() === '' &&
      !img.ariaHidden &&
      img.role !== 'presentation'
  );
  if (emptyAlt.length > 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t(
        `${emptyAlt.length} <img> avec alt vide (vérifier décoratif vs informatif).`,
        `${emptyAlt.length} <img> with empty alt (verify decorative vs informative).`
      ),
      examples: takeExamples(
        emptyAlt,
        (img) =>
          `img alt="" role=${img.role || '(none)'} aria-hidden=${img.ariaHidden} name=${clipText(img.name, 50) || '(empty)'}`
      )
    };
  }

  const roleImgMissingName = images.filter(
    (img) => img.tag !== 'img' && img.role === 'img' && !img.name
  );
  if (roleImgMissingName.length > 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t(
        `${roleImgMissingName.length} role="img" sans nom accessible.`,
        `${roleImgMissingName.length} role="img" without accessible name.`
      ),
      examples: takeExamples(roleImgMissingName, () => `role="img" name=(empty)`)
    };
  }

  return { status: STATUS.C };
}

function evaluateFramesTitle(snapshot, i18n) {
  const frames = snapshot.frames || [];
  if (frames.length === 0) {
    return { status: STATUS.NA, notes: i18n.t('Aucun cadre (frame/iframe) détecté.', 'No frames/iframes found.') };
  }

  const missing = frames.filter(
    (frame) => !frame.title && !frame.ariaLabel && !frame.ariaLabelledby
  );
  if (missing.length > 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t(
        `${missing.length} frame(s) sans title (ou nom ARIA).`,
        `${missing.length} frame(s) missing title.`
      ),
      examples: takeExamples(
        missing,
        (f) =>
          `iframe title="" aria-label="" aria-labelledby=""`,
        2
      )
    };
  }
  return { status: STATUS.C };
}

function evaluateLinksHaveName(snapshot, i18n) {
  const links = snapshot.links || [];
  if (links.length === 0) {
    return { status: STATUS.NA, notes: i18n.t('Aucun lien détecté.', 'No links found.') };
  }

  const missing = links.filter((link) => !link.name);
  if (missing.length > 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t(
        `${missing.length} lien(s) sans nom accessible.`,
        `${missing.length} link(s) without accessible name.`
      ),
      examples: takeExamples(
        missing,
        (l) =>
          `a href=${clipText(l.href, 50) || '(missing)'} text=(empty) aria-label=${clipText(l.ariaLabel, 20) || '""'} title=${clipText(l.title, 20) || '""'}`
      )
    };
  }
  return { status: STATUS.C };
}

function evaluateLinksExplicit(snapshot, i18n) {
  const links = snapshot.links || [];
  if (links.length === 0) {
    return { status: STATUS.NA, notes: i18n.t('Aucun lien détecté.', 'No links found.') };
  }

  const generic = links.filter((link) => {
    const name = normalizeText(link.name);
    if (!name) return false;
    if (GENERIC_LINK_TEXTS.has(name)) return true;
    if (name.length <= 3 && ['+','→','>>','>'].includes(name)) return true;
    return false;
  });

  if (generic.length > 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t(
        `${generic.length} lien(s) avec libellé générique (vérifier explicitation).`,
        `${generic.length} link(s) with generic label (review explicitness).`
      ),
      examples: takeExamples(
        generic,
        (l) => `"${clipText(l.name, 28) || '(empty)'}" → ${clipText(l.href, 46) || '(missing href)'}`
      )
    };
  }

  return { status: STATUS.C };
}

function evaluateLangPresent(snapshot, i18n) {
  const lang = (snapshot.lang || '').trim();
  return lang
    ? { status: STATUS.C }
    : {
        status: STATUS.NC,
        notes: i18n.t('Attribut lang manquant sur <html>.', 'Missing lang attribute on <html>.'),
        examples: [i18n.t('Ex: <html lang="fr">…</html>', 'E.g.: <html lang="en">…</html>')]
      };
}

function evaluateLangValid(snapshot, i18n) {
  const lang = (snapshot.lang || '').trim();
  if (!lang) return { status: STATUS.NA, notes: i18n.t('Aucune langue par défaut déclarée.', 'No default lang declared.') };
  return isValidLangCode(lang)
    ? { status: STATUS.C }
    : {
        status: STATUS.NC,
        notes: i18n.t(`Code lang invalide : ${lang}`, `Invalid lang code: ${lang}`),
        examples: [i18n.t(`Ex: lang="fr" ou lang="fr-FR"`, `E.g.: lang="en" or lang="en-US"`)]
      };
}

function evaluateTitlePresent(snapshot, i18n) {
  const title = (snapshot.title || '').trim();
  return title
    ? { status: STATUS.C }
    : {
        status: STATUS.NC,
        notes: i18n.t('<title> manquant.', 'Missing <title>.'),
        examples: [i18n.t('Ex: <title>Lingerie & Sous-vêtements femme</title>', 'E.g.: <title>Contact</title>')]
      };
}

function evaluateDoctype(snapshot, i18n) {
  return snapshot.doctype
    ? { status: STATUS.C }
    : {
        status: STATUS.NC,
        notes: i18n.t('Doctype du document manquant.', 'Missing document doctype.'),
        examples: [i18n.t('Ex: <!doctype html>', 'E.g.: <!doctype html>')]
      };
}

function evaluateLangChangesDeclared(snapshot, i18n) {
  const changes = snapshot.langChanges || [];
  if (changes.length === 0) {
    return { status: STATUS.NA, notes: i18n.t('Aucun changement de langue détecté.', 'No language changes detected.') };
  }
  return {
    status: STATUS.C,
    notes: i18n.t(
      'Changements de langue déclarés via des attributs lang (vérification manuelle recommandée).',
      'Language changes are declared via lang attributes (manual verification recommended).'
    )
  };
}

function evaluateLangChangesValid(snapshot, i18n) {
  const changes = snapshot.langChanges || [];
  if (changes.length === 0) {
    return { status: STATUS.NA, notes: i18n.t('Aucun changement de langue détecté.', 'No language changes detected.') };
  }
  const invalid = changes.filter((lang) => !isValidLangCode(lang));
  if (invalid.length > 0) {
    return { status: STATUS.NC, notes: i18n.t(`Codes lang invalides : ${invalid.join(', ')}`, `Invalid lang codes: ${invalid.join(', ')}`) };
  }
  return { status: STATUS.C };
}

function evaluateHeadingStructure(snapshot, i18n) {
  const headings = snapshot.headings || [];
  if (headings.length === 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t('Aucun titre (Hn) détecté.', 'No headings found.'),
      examples: [i18n.t('Ex: <h1>…</h1> (puis <h2>…</h2>, etc.)', 'E.g.: <h1>…</h1> (then <h2>…</h2>, etc.)')]
    };
  }

  const h1Count = headings.filter((h) => h.level === 1).length;
  if (h1Count === 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t('H1 manquant.', 'Missing H1.'),
      examples: takeExamples(
        headings.slice(0, 4),
        (h) => `h${h.level}: ${clipText(h.text, 40) || '(empty)'}`
      )
    };
  }
  if (h1Count > 1) {
    const h1s = headings.filter((h) => h.level === 1);
    return {
      status: STATUS.NC,
      notes: i18n.t(`Plusieurs H1 (${h1Count}).`, `Multiple H1 (${h1Count}).`),
      examples: takeExamples(h1s, (h) => `h1: ${clipText(h.text, 50) || '(empty)'}`)
    };
  }

  let prev = headings[0].level;
  for (const h of headings.slice(1)) {
    if (h.level - prev > 1) {
      return {
        status: STATUS.NC,
        notes: i18n.t('Sauts de niveaux de titres détectés.', 'Heading level jumps detected.'),
        examples: takeExamples(
          headings.slice(0, 6),
          (x) => `h${x.level}: ${clipText(x.text, 34) || '(empty)'}`
        )
      };
    }
    prev = h.level;
  }

  return { status: STATUS.C };
}

function evaluateListStructure(snapshot, i18n) {
  const items = snapshot.listItems || [];
  if (items.length === 0) {
    return { status: STATUS.NA, notes: i18n.t('Aucun élément de liste détecté.', 'No list items found.') };
  }
  const invalid = items.filter((item) => !['ul', 'ol', 'menu'].includes(item.parent));
  if (invalid.length > 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t(
        `${invalid.length} élément(s) <li> hors liste.`,
        `${invalid.length} list item(s) not in a list.`
      ),
      examples: takeExamples(invalid, (i) => `li parent=<${i.parent || 'unknown'}>`, 3)
    };
  }
  return { status: STATUS.C };
}

function evaluateFormLabels(snapshot, i18n) {
  const controls = snapshot.formControls || [];
  if (controls.length === 0) {
    return { status: STATUS.NA, notes: i18n.t('Aucun champ de formulaire détecté.', 'No form controls found.') };
  }
  const missing = controls.filter((control) => !control.label);
  if (missing.length > 0) {
    return {
      status: STATUS.NC,
      notes: i18n.t(
        `${missing.length} champ(s) sans libellé.`,
        `${missing.length} form control(s) without label.`
      ),
      examples: takeExamples(
        missing,
        (c) => {
          const id = c.id ? `#${c.id}` : '';
          const name = c.name ? `[name=${c.name}]` : '';
          const type = c.type ? `[type=${c.type}]` : '';
          return `${c.tag}${type}${id}${name} label=""`;
        },
        3
      )
    };
  }
  return { status: STATUS.C };
}

function evaluateSkipLink(snapshot, i18n) {
  const links = snapshot.links || [];
  const skip = links.find((link) => {
    const name = normalizeText(link.name);
    if (!link.href || !link.href.startsWith('#')) return false;
    return name.includes('contenu') || name.includes('skip') || name.includes('principal');
  });

  if (skip) {
    return { status: STATUS.C };
  }

  const hashLinks = links.filter((l) => (l.href || '').startsWith('#'));
  return {
    status: STATUS.NC,
    notes: i18n.t('Aucun lien d’évitement vers le contenu principal détecté.', 'No skip link to main content detected.'),
    examples:
      hashLinks.length > 0
        ? takeExamples(hashLinks, (l) => `"${clipText(l.name, 24) || '(empty)'}" → ${clipText(l.href, 40)}`, 3)
        : [i18n.t('Ex: "Aller au contenu" → #main', 'E.g.: "Skip to content" → #main')]
  };
}

const RULES = new Map([
  ['1.1', evaluateImagesAlt],
  ['2.1', evaluateFramesTitle],
  ['6.1', evaluateLinksExplicit],
  ['6.2', evaluateLinksHaveName],
  ['8.1', evaluateDoctype],
  ['8.3', evaluateLangPresent],
  ['8.4', evaluateLangValid],
  ['8.5', evaluateTitlePresent],
  ['8.7', evaluateLangChangesDeclared],
  ['8.8', evaluateLangChangesValid],
  ['9.1', evaluateHeadingStructure],
  ['9.3', evaluateListStructure],
  ['11.1', evaluateFormLabels],
  ['12.7', evaluateSkipLink]
]);

const THEME_APPLICABILITY = {
  Images: (snapshot) => (snapshot.images || []).length > 0,
  Cadres: (snapshot) => (snapshot.frames || []).length > 0,
  Frames: (snapshot) => (snapshot.frames || []).length > 0,
  Multimédia: (snapshot) => {
    const media = snapshot.media || {};
    return (media.video || 0) + (media.audio || 0) + (media.object || 0) > 0;
  },
  Multimedia: (snapshot) => {
    const media = snapshot.media || {};
    return (media.video || 0) + (media.audio || 0) + (media.object || 0) > 0;
  },
  Tableaux: (snapshot) => (snapshot.tables || []).length > 0,
  Tables: (snapshot) => (snapshot.tables || []).length > 0,
  Liens: (snapshot) => (snapshot.links || []).length > 0,
  Links: (snapshot) => (snapshot.links || []).length > 0,
  Scripts: (snapshot) => {
    const scripts = snapshot.scripts || {};
    return (scripts.scriptTags || 0) > 0 || scripts.hasInlineHandlers;
  },
  Formulaires: (snapshot) => (snapshot.formControls || []).length > 0,
  Forms: (snapshot) => (snapshot.formControls || []).length > 0
};

export function evaluateCriterion(criterion, snapshot, options = {}) {
  const i18n = getI18n(normalizeReportLang(options.lang));
  const rule = RULES.get(criterion.id);
  if (rule) {
    const res = rule(snapshot, i18n) || {};
    return {
      ...res,
      automated: typeof res.automated === 'boolean' ? res.automated : true,
      aiCandidate: typeof res.aiCandidate === 'boolean' ? res.aiCandidate : false
    };
  }

  const applies = THEME_APPLICABILITY[criterion.theme]
    ? THEME_APPLICABILITY[criterion.theme](snapshot)
    : true;

  if (!applies) {
    return {
      status: STATUS.NA,
      notes: i18n.t('Non applicable pour cette page.', 'Not applicable for this page.'),
      automated: false,
      aiCandidate: false
    };
  }

  return {
    status: STATUS.AI,
    notes: i18n.t('Revue requise.', 'Review required.'),
    automated: false,
    aiCandidate: true
  };
}
