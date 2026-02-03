import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCriteria } from '../src/criteria.js';
import { evaluateCriterion, STATUS } from '../src/checks.js';

function criterionById(id) {
  return loadCriteria().find((c) => c.id === id);
}

const baseSnapshot = {
  doctype: 'html',
  title: 'Test',
  lang: 'fr',
  href: 'https://example.test/',
  readyState: 'complete',
  images: [],
  frames: [],
  links: [],
  formControls: [],
  headings: [],
  listItems: [],
  langChanges: [],
  tables: [],
  media: { video: 0, audio: 0, object: 0 },
  visual: { svg: 0, canvas: 0, picture: 0, cssBackgroundImages: 0, bgExamples: [] },
  scripts: { scriptTags: 0, hasInlineHandlers: false }
};

test('criteria list has 106 unique entries', () => {
  const criteria = loadCriteria();
  assert.equal(criteria.length, 106);
  const ids = new Set(criteria.map((c) => c.id));
  assert.equal(ids.size, 106);
});

test('english criteria list matches ids', () => {
  const fr = loadCriteria({ lang: 'fr' });
  const en = loadCriteria({ lang: 'en' });
  assert.equal(en.length, 106);
  const frIds = new Set(fr.map((c) => c.id));
  const enIds = new Set(en.map((c) => c.id));
  assert.equal(enIds.size, 106);
  for (const id of frIds) {
    assert.ok(enIds.has(id), `EN criteria should include id ${id}`);
  }
});

test('1.1 images alt rule', () => {
  const criterion = criterionById('1.1');
  const good = evaluateCriterion(criterion, {
    ...baseSnapshot,
    images: [{ tag: 'img', alt: 'Photo', ariaHidden: false, role: '', name: 'Photo' }]
  });
  assert.equal(good.status, STATUS.C);

  const bad = evaluateCriterion(criterion, {
    ...baseSnapshot,
    images: [{ tag: 'img', alt: null, ariaHidden: false, role: '', name: '' }]
  });
  assert.equal(bad.status, STATUS.NC);

  const na = evaluateCriterion(criterion, baseSnapshot);
  assert.equal(na.status, STATUS.NA);

  const needsReview = evaluateCriterion(criterion, {
    ...baseSnapshot,
    visual: { ...baseSnapshot.visual, cssBackgroundImages: 2 }
  });
  assert.equal(needsReview.status, STATUS.AI);
  assert.equal(needsReview.aiCandidate, true);
});

test('2.1 frames title rule', () => {
  const criterion = criterionById('2.1');
  const good = evaluateCriterion(criterion, {
    ...baseSnapshot,
    frames: [{ title: 'Video', ariaLabel: '', ariaLabelledby: '' }]
  });
  assert.equal(good.status, STATUS.C);

  const bad = evaluateCriterion(criterion, {
    ...baseSnapshot,
    frames: [{ title: '', ariaLabel: '', ariaLabelledby: '' }]
  });
  assert.equal(bad.status, STATUS.NC);
});

test('6.2 links have name rule', () => {
  const criterion = criterionById('6.2');
  const good = evaluateCriterion(criterion, {
    ...baseSnapshot,
    links: [{ href: '/test', name: 'Lien', rawText: 'Lien', title: '', ariaLabel: '' }]
  });
  assert.equal(good.status, STATUS.C);

  const bad = evaluateCriterion(criterion, {
    ...baseSnapshot,
    links: [{ href: '/test', name: '', rawText: '', title: '', ariaLabel: '' }]
  });
  assert.equal(bad.status, STATUS.NC);
});

test('8.3 lang present rule', () => {
  const criterion = criterionById('8.3');
  const good = evaluateCriterion(criterion, { ...baseSnapshot, lang: 'fr' });
  assert.equal(good.status, STATUS.C);

  const bad = evaluateCriterion(criterion, { ...baseSnapshot, lang: '' });
  assert.equal(bad.status, STATUS.NC);
});

test('9.1 heading structure rule', () => {
  const criterion = criterionById('9.1');
  const missing = evaluateCriterion(criterion, { ...baseSnapshot, headings: [] });
  assert.equal(missing.status, STATUS.NC);

  const ok = evaluateCriterion(criterion, {
    ...baseSnapshot,
    headings: [{ level: 1, text: 'Titre' }, { level: 2, text: 'Section' }]
  });
  assert.equal(ok.status, STATUS.C);

  const jump = evaluateCriterion(criterion, {
    ...baseSnapshot,
    headings: [{ level: 1, text: 'Titre' }, { level: 3, text: 'Section' }]
  });
  assert.equal(jump.status, STATUS.NC);
});

test('11.1 form label rule', () => {
  const criterion = criterionById('11.1');
  const good = evaluateCriterion(criterion, {
    ...baseSnapshot,
    formControls: [{ tag: 'input', type: 'text', id: 'name', name: 'name', label: 'Nom' }]
  });
  assert.equal(good.status, STATUS.C);

  const bad = evaluateCriterion(criterion, {
    ...baseSnapshot,
    formControls: [{ tag: 'input', type: 'text', id: 'name', name: 'name', label: '' }]
  });
  assert.equal(bad.status, STATUS.NC);
});

test('12.7 skip link rule', () => {
  const criterion = criterionById('12.7');
  const good = evaluateCriterion(criterion, {
    ...baseSnapshot,
    links: [{ href: '#main', name: 'Aller au contenu principal', rawText: '', title: '', ariaLabel: '' }]
  });
  assert.equal(good.status, STATUS.C);

  const bad = evaluateCriterion(criterion, {
    ...baseSnapshot,
    links: [{ href: '/other', name: 'Accueil', rawText: '', title: '', ariaLabel: '' }]
  });
  assert.equal(bad.status, STATUS.NC);
});

test('non-automated but applicable criteria are flagged for AI review', () => {
  const criterion = criterionById('7.1');
  const result = evaluateCriterion(criterion, {
    ...baseSnapshot,
    scripts: { scriptTags: 1, hasInlineHandlers: false }
  });
  assert.equal(result.status, STATUS.AI);
  assert.equal(result.aiCandidate, true);
});
