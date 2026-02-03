export function getSnapshotExpression() {
  const shouldScroll = (() => {
    const raw = String(process.env.AUDIT_SNAPSHOT_SCROLL || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  })();
  const maxItems = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_ITEMS || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
  })();
  const snapshotMode = (() => {
    const raw = String(process.env.AUDIT_SNAPSHOT_MODE || '').trim().toLowerCase();
    return raw || 'lite';
  })();
  const countsOnly = snapshotMode === 'counts';
  const collectArrays = snapshotMode === 'full';
  const maxLinks = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_LINKS || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
  })();
  const maxImages = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_IMAGES || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
  })();
  const maxListItems = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_LIST_ITEMS || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
  })();
  const maxFormControls = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_FORM_CONTROLS || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
  })();
  const maxHeadings = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_HEADINGS || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120;
  })();
  const maxButtons = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_BUTTONS || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120;
  })();
  const maxLandmarks = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_LANDMARKS || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 80;
  })();
  const maxFocusables = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_FOCUSABLES || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120;
  })();
  const maxTables = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_TABLES || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120;
  })();
  const maxFieldsets = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_FIELDSETS || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 80;
  })();
  const maxText = (() => {
    const raw = Number(process.env.AUDIT_SNAPSHOT_MAX_TEXT || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
  })();

  return `(async () => {
    const doc = document;
    const html = doc.documentElement;

    const clip = (value, max = ${maxText}) => {
      const str = value == null ? '' : String(value);
      if (!max || str.length <= max) return str;
      return str.slice(0, max - 1) + '…';
    };

    const doctype = doc.doctype ? doc.doctype.name : '';
    const title = clip(doc.title || '');
    const lang = clip((html && html.getAttribute('lang')) || '');
    const dir = clip((html && html.getAttribute('dir')) || '');
    const href = String(location && location.href ? location.href : '');
    const readyState = doc.readyState || '';

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const scrollToLoadLazyContent = async () => {
      const maxSteps = 12;
      const step = Math.max(200, Math.floor(window.innerHeight * 0.85));
      const total = Math.max(doc.body ? doc.body.scrollHeight : 0, doc.documentElement.scrollHeight || 0);
      const steps = Math.max(1, Math.min(maxSteps, Math.ceil(total / step)));
      for (let i = 0; i < steps; i += 1) {
        window.scrollTo(0, Math.min(total, i * step));
        await sleep(120);
      }
      await sleep(300);
      window.scrollTo(0, 0);
      await sleep(120);
    };

    if (${shouldScroll}) {
      await scrollToLoadLazyContent();
    }

    const cap = (arr, max = ${maxItems}) => (Array.isArray(arr) ? arr.slice(0, max) : arr);
    const collectArrays = ${collectArrays};

    const getText = (node) => clip(node ? (node.textContent || '') : '');
    const getLabelledBy = (el) => {
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      return clip(ids.map((id) => getText(doc.getElementById(id))).join(' ').trim());
    };

    const getDescribedBy = (el) => {
      const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      return clip(ids.map((id) => getText(doc.getElementById(id))).join(' ').trim());
    };

    const getAccessibleName = (el) => {
      const ariaLabel = clip((el.getAttribute('aria-label') || '').trim());
      if (ariaLabel) return ariaLabel;
      const labelledBy = getLabelledBy(el);
      if (labelledBy) return labelledBy;

      if (el.tagName === 'IMG') {
        const alt = el.getAttribute('alt');
        if (alt !== null) return clip(alt.trim());
      }

      const text = clip((el.textContent || '').trim());
      if (text) return text;

      const titleAttr = clip((el.getAttribute('title') || '').trim());
      if (titleAttr) return titleAttr;

      return '';
    };

    const normalizeLinkText = (text) =>
      String(text || '')
        .toLowerCase()
        .replace(/[\u2019'".,:;!?()\[\]{}]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
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

    const imageNodes = Array.from(doc.querySelectorAll('img, [role="img"]'));
    const images = [];
    const imageSummary = {
      total: imageNodes.length,
      missingAltCount: 0,
      roleImgMissingNameCount: 0
    };
    for (const el of imageNodes) {
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const ariaHidden = (el.getAttribute('aria-hidden') || '').toLowerCase() === 'true';
      const alt = el.getAttribute('alt');
      const name = getAccessibleName(el);
      if (tag === 'img' && alt === null && !ariaHidden) imageSummary.missingAltCount += 1;
      if (tag !== 'img' && role === 'img' && !name) imageSummary.roleImgMissingNameCount += 1;
      if (collectArrays) {
        images.push({
          tag,
          role,
          ariaHidden,
          alt: alt === null ? null : clip(alt),
          name: clip(name)
        });
      }
    }

    const frameNodes = Array.from(doc.querySelectorAll('iframe, frame'));
    const frames = [];
    const frameSummary = {
      total: frameNodes.length,
      missingTitleCount: 0
    };
    for (const el of frameNodes) {
      const title = clip((el.getAttribute('title') || '').trim());
      const ariaLabel = clip((el.getAttribute('aria-label') || '').trim());
      const ariaLabelledby = clip((el.getAttribute('aria-labelledby') || '').trim());
      if (!title && !ariaLabel && !ariaLabelledby) frameSummary.missingTitleCount += 1;
      if (collectArrays) {
        frames.push({ title, ariaLabel, ariaLabelledby });
      }
    }

    const linkNodes = Array.from(doc.querySelectorAll('a[href]'));
    const links = [];
    const linkSummary = {
      total: linkNodes.length,
      targetBlank: 0,
      targetBlankNoRel: 0,
      fragmentLinks: 0,
      missingNameCount: 0,
      genericCount: 0,
      skipLinkFound: false
    };
    for (const el of linkNodes) {
      const name = getAccessibleName(el);
      const href = (el.getAttribute('href') || '').trim();
      const target = (el.getAttribute('target') || '').trim();
      const rel = (el.getAttribute('rel') || '').trim();
      if (!name) {
        linkSummary.missingNameCount += 1;
      } else {
        const normalized = normalizeLinkText(name);
        if (
          GENERIC_LINK_TEXTS.has(normalized) ||
          (normalized.length <= 3 && ['+', '→', '>>', '>'].includes(normalized))
        ) {
          linkSummary.genericCount += 1;
        }
        if (href.startsWith('#')) {
          if (normalized.includes('contenu') || normalized.includes('skip') || normalized.includes('principal')) {
            linkSummary.skipLinkFound = true;
          }
        }
      }
      if (target === '_blank') {
        linkSummary.targetBlank += 1;
        const relLower = rel.toLowerCase();
        if (!relLower.includes('noopener') && !relLower.includes('noreferrer')) {
          linkSummary.targetBlankNoRel += 1;
        }
      }
      if (href.startsWith('#')) linkSummary.fragmentLinks += 1;

      if (collectArrays) {
        links.push({
          href,
          name: clip(name),
          rawText: clip((el.textContent || '').trim()),
          title: clip((el.getAttribute('title') || '').trim()),
          ariaLabel: clip((el.getAttribute('aria-label') || '').trim()),
          ariaLabelledby: clip((el.getAttribute('aria-labelledby') || '').trim()),
          target: clip(target),
          rel: clip(rel)
        });
      }
    }

    const isFormControl = (el) => {
      if (el.matches('input[type="hidden"], input[type="submit"], input[type="reset"], input[type="button"], button')) {
        return false;
      }
      return el.matches('input, select, textarea');
    };

    const getControlLabel = (el) => {
      const aria = getAccessibleName(el);
      if (aria) return aria;
      const id = el.getAttribute('id');
      if (id) {
        const selector = 'label[for=\"' + CSS.escape(id) + '\"]';
        const label = doc.querySelector(selector);
        if (label) return clip((label.textContent || '').trim());
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return clip((parentLabel.textContent || '').trim());
      return '';
    };

    const getFieldsetLegend = (fieldset) => {
      if (!fieldset) return '';
      const legend = fieldset.querySelector('legend');
      return legend ? clip((legend.textContent || '').trim()) : '';
    };

    const formControls = [];
    const formSummary = {
      controlsTotal: 0,
      missingLabel: 0,
      requiredCount: 0,
      autocompleteCount: 0,
      describedByCount: 0,
      inFieldsetCount: 0,
      fieldsetCount: 0,
      fieldsetWithLegendCount: 0
    };
    const fieldsets = [];

    const fieldsetNodes = Array.from(doc.querySelectorAll('fieldset'));
    formSummary.fieldsetCount = fieldsetNodes.length;
    for (const fieldset of fieldsetNodes) {
      const legend = getFieldsetLegend(fieldset);
      if (legend) formSummary.fieldsetWithLegendCount += 1;
      if (!collectArrays) continue;
      if (fieldsets.length >= 30) continue;
      const controls = Array.from(
        fieldset.querySelectorAll('input, select, textarea, button')
      )
        .filter(isFormControl)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: clip((el.getAttribute('type') || '').toLowerCase()),
          id: clip(el.getAttribute('id') || ''),
          name: clip(el.getAttribute('name') || ''),
          label: clip(getControlLabel(el)),
          required: el.hasAttribute('required'),
          ariaRequired: (el.getAttribute('aria-required') || '').toLowerCase() === 'true',
          autocomplete: clip((el.getAttribute('autocomplete') || '').trim())
        }));
      fieldsets.push({
        legend,
        hasLegend: Boolean(legend),
        controlCount: controls.length,
        controls: controls.slice(0, 12)
      });
    }

    const controlNodes = Array.from(doc.querySelectorAll('input, select, textarea, button'))
      .filter(isFormControl);
    for (const el of controlNodes) {
      const fieldset = el.closest('fieldset');
      const fieldsetLegend = getFieldsetLegend(fieldset);
      const label = getControlLabel(el);
      const required = el.hasAttribute('required');
      const ariaRequired = (el.getAttribute('aria-required') || '').toLowerCase() === 'true';
      const autocomplete = (el.getAttribute('autocomplete') || '').trim();
      const describedBy = getDescribedBy(el);
      formSummary.controlsTotal += 1;
      if (!label) formSummary.missingLabel += 1;
      if (required || ariaRequired) formSummary.requiredCount += 1;
      if (autocomplete && autocomplete !== 'off') formSummary.autocompleteCount += 1;
      if (describedBy) formSummary.describedByCount += 1;
      if (fieldset) formSummary.inFieldsetCount += 1;

      if (collectArrays) {
        formControls.push({
          tag: el.tagName.toLowerCase(),
          type: clip((el.getAttribute('type') || '').toLowerCase()),
          id: clip(el.getAttribute('id') || ''),
          name: clip(el.getAttribute('name') || ''),
          label: clip(label),
          required,
          ariaRequired,
          autocomplete: clip(autocomplete),
          describedBy: clip(describedBy),
          inFieldset: Boolean(fieldset),
          fieldsetLegend: clip(fieldsetLegend)
        });
      }
    }

    const headings = [];
    const headingsSummary = { total: 0, h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
    const headingAnalysis = { h1Count: 0, hasLevelJumps: false };
    let prevHeadingLevel = null;
    const headingNodes = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    for (const el of headingNodes) {
      const level = Number(el.tagName.replace('H', ''));
      headingsSummary.total += 1;
      const key = 'h' + level;
      if (key in headingsSummary) headingsSummary[key] += 1;
      if (level === 1) headingAnalysis.h1Count += 1;
      if (prevHeadingLevel !== null && level - prevHeadingLevel > 1) {
        headingAnalysis.hasLevelJumps = true;
      }
      prevHeadingLevel = level;
      if (collectArrays) {
        headings.push({
          level,
          text: clip((el.textContent || '').trim())
        });
      }
    }

    const listNodes = Array.from(doc.querySelectorAll('li'));
    const listItems = [];
    const listSummary = { total: listNodes.length, invalidCount: 0 };
    for (const el of listNodes) {
      const parent = el.parentElement ? el.parentElement.tagName.toLowerCase() : '';
      if (!['ul', 'ol', 'menu'].includes(parent)) listSummary.invalidCount += 1;
      if (collectArrays) listItems.push({ parent: clip(parent) });
    }

    const langChanges = Array.from(doc.querySelectorAll('[lang]'))
      .map((el) => clip((el.getAttribute('lang') || '').trim()))
      .filter((val) => val && val !== lang);

    const dirChanges = Array.from(doc.querySelectorAll('[dir]'))
      .map((el) => clip((el.getAttribute('dir') || '').trim().toLowerCase()))
      .filter((val) => val && val !== dir);

    const tables = [];
    const tableSummary = {
      total: 0,
      withCaption: 0,
      withTh: 0,
      withScope: 0,
      withId: 0,
      withHeadersAttr: 0,
      withThead: 0
    };
    const tableNodes = Array.from(doc.querySelectorAll('table'));
    tableSummary.total = tableNodes.length;
    for (const table of tableNodes) {
      const hasTh = !!table.querySelector('th');
      const hasCaption = !!table.querySelector('caption');
      const ths = Array.from(table.querySelectorAll('th'));
      const thWithScope = ths.filter((th) => th.hasAttribute('scope')).length;
      const thWithId = ths.filter((th) => th.hasAttribute('id')).length;
      const cellsWithHeaders = table.querySelectorAll('td[headers]').length;
      const hasThead = !!table.querySelector('thead');
      const hasTbody = !!table.querySelector('tbody');
      const hasTfoot = !!table.querySelector('tfoot');
      if (hasCaption) tableSummary.withCaption += 1;
      if (hasTh) tableSummary.withTh += 1;
      if (thWithScope > 0) tableSummary.withScope += 1;
      if (thWithId > 0) tableSummary.withId += 1;
      if (cellsWithHeaders > 0) tableSummary.withHeadersAttr += 1;
      if (hasThead) tableSummary.withThead += 1;
      if (collectArrays) {
        tables.push({
          hasTh,
          hasCaption,
          thCount: ths.length,
          thWithScope,
          thWithId,
          cellsWithHeaders,
          hasThead,
          hasTbody,
          hasTfoot
        });
      }
    }

    const buttons = Array.from(doc.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]'))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: clip((el.getAttribute('type') || '').toLowerCase()),
        role: clip((el.getAttribute('role') || '').toLowerCase()),
        name: clip(getAccessibleName(el))
      }))
      .filter((btn) => btn.name || btn.tag || btn.role);

    const landmarks = (() => {
      const landmarkRoles = new Set([
        'banner',
        'navigation',
        'main',
        'contentinfo',
        'search',
        'complementary',
        'form',
        'region'
      ]);
      const tags = ['header', 'nav', 'main', 'footer', 'aside', 'form', 'section'];
      const nodes = Array.from(doc.querySelectorAll(tags.join(',')));
      const roleNodes = Array.from(doc.querySelectorAll('[role]'))
        .filter((el) => landmarkRoles.has((el.getAttribute('role') || '').toLowerCase()));
      const combined = Array.from(new Set([...nodes, ...roleNodes]));
      return combined.map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: clip((el.getAttribute('role') || '').toLowerCase()),
        label: clip(getAccessibleName(el))
      }));
    })();

    const meta = (() => {
      const viewport = doc.querySelector('meta[name="viewport"]');
      const refresh = doc.querySelector('meta[http-equiv="refresh"]');
      return {
        viewport: viewport ? clip((viewport.getAttribute('content') || '').trim()) : '',
        refresh: refresh ? clip((refresh.getAttribute('content') || '').trim()) : ''
      };
    })();

    const mediaDetails = (() => {
      const trackKinds = (el) =>
        Array.from(el.querySelectorAll('track')).map((track) =>
          (track.getAttribute('kind') || '').toLowerCase()
        );
      const summarize = (el) => {
        const kinds = trackKinds(el);
        const hasKind = (kind) => kinds.includes(kind);
        return {
          hasControls: el.hasAttribute('controls') || Boolean(el.controls),
          autoplay: el.hasAttribute('autoplay') || Boolean(el.autoplay),
          muted: el.hasAttribute('muted') || Boolean(el.muted),
          loop: el.hasAttribute('loop') || Boolean(el.loop),
          hasCaptions: hasKind('captions'),
          hasSubtitles: hasKind('subtitles'),
          hasDescriptions: hasKind('descriptions'),
          hasChapters: hasKind('chapters'),
          hasMetadata: hasKind('metadata')
        };
      };
      return {
        videos: Array.from(doc.querySelectorAll('video')).map(summarize),
        audios: Array.from(doc.querySelectorAll('audio')).map(summarize)
      };
    })();

    const media = {
      video: doc.querySelectorAll('video').length,
      audio: doc.querySelectorAll('audio').length,
      object: doc.querySelectorAll('object, embed').length
    };

    const visual = (() => {
      const svg = doc.querySelectorAll('svg').length;
      const canvas = doc.querySelectorAll('canvas').length;
      const picture = doc.querySelectorAll('picture').length;

      let cssBackgroundImages = 0;
      const bgExamples = [];
      try {
        const els = Array.from(doc.querySelectorAll('body *'));
        const maxScan = 2000;
        for (let i = 0; i < els.length && i < maxScan; i += 1) {
          const el = els[i];
          const style = window.getComputedStyle(el);
          const bg = style && style.backgroundImage ? String(style.backgroundImage) : '';
          if (!bg || bg === 'none') continue;
          if (!bg.includes('url(')) continue;
          cssBackgroundImages += 1;
          if (bgExamples.length < 3) {
            const className = typeof el.className === 'string' ? el.className.trim() : '';
            const id = (el.getAttribute('id') || '').trim();
            const ariaHidden = (el.getAttribute('aria-hidden') || '').toLowerCase() === 'true';
            bgExamples.push({
              tag: el.tagName.toLowerCase(),
              id,
              className: className.length > 80 ? className.slice(0, 77) + '…' : className,
              ariaHidden,
              backgroundImage: bg.length > 140 ? bg.slice(0, 137) + '…' : bg
            });
          }
          if (cssBackgroundImages >= 40) break;
        }
      } catch (_) {}

      return { svg, canvas, picture, cssBackgroundImages, bgExamples };
    })();

    const scripts = {
      scriptTags: doc.querySelectorAll('script').length,
      hasInlineHandlers: !!doc.querySelector('[onclick],[onkeydown],[onkeyup],[onkeypress],[onmouseover],[onfocus],[onblur]')
    };

    const focusables = (() => {
      const selector =
        'a[href], button, input, select, textarea, [tabindex], [role="button"], [role="link"]';
      const nodes = Array.from(doc.querySelectorAll(selector));
      const out = [];
      const maxItems = 80;
      for (const el of nodes) {
        if (out.length >= maxItems) break;
        const tabindexAttr = el.getAttribute('tabindex');
        const tabIndex = tabindexAttr !== null ? Number(tabindexAttr) : el.tabIndex;
        if (Number.isNaN(tabIndex)) continue;
        if (tabIndex < 0) continue;
        const disabled = 'disabled' in el ? Boolean(el.disabled) : el.hasAttribute('disabled');
        if (disabled) continue;
        out.push({
          tag: el.tagName.toLowerCase(),
          role: clip((el.getAttribute('role') || '').toLowerCase()),
          tabindex: tabIndex,
          type: clip((el.getAttribute('type') || '').toLowerCase())
        });
      }
      return out;
    })();
    const focusableSummary = (() => {
      const summary = {
        total: focusables.length,
        tabindexPositive: 0,
        tabindexZero: 0,
        maxTabindex: 0
      };
      for (const el of focusables) {
        if (el.tabindex > 0) summary.tabindexPositive += 1;
        if (el.tabindex === 0) summary.tabindexZero += 1;
        if (el.tabindex > summary.maxTabindex) summary.maxTabindex = el.tabindex;
      }
      return summary;
    })();

    const ariaLive = (() => {
      const liveNodes = Array.from(doc.querySelectorAll('[aria-live]'));
      const roleNodes = Array.from(
        doc.querySelectorAll('[role="alert"],[role="status"],[role="log"],[role="marquee"],[role="timer"]')
      );
      const politeness = { polite: 0, assertive: 0, off: 0 };
      for (const el of liveNodes) {
        const value = (el.getAttribute('aria-live') || '').trim().toLowerCase();
        if (value === 'polite') politeness.polite += 1;
        else if (value === 'assertive') politeness.assertive += 1;
        else if (value === 'off') politeness.off += 1;
      }
      const roles = { alert: 0, status: 0, log: 0, marquee: 0, timer: 0 };
      for (const el of roleNodes) {
        const role = (el.getAttribute('role') || '').trim().toLowerCase();
        if (role in roles) roles[role] += 1;
      }
      return {
        liveRegions: liveNodes.length,
        rolesCount: roleNodes.length,
        politeness,
        roles
      };
    })();

    const ariaSummary = (() => {
      const label = doc.querySelectorAll('[aria-label]').length;
      const labelledby = doc.querySelectorAll('[aria-labelledby]').length;
      const describedby = doc.querySelectorAll('[aria-describedby]').length;
      const hidden = doc.querySelectorAll('[aria-hidden="true"]').length;
      return { label, labelledby, describedby, hidden };
    })();

    const rolesSummary = (() => {
      const nodes = Array.from(doc.querySelectorAll('[role]'));
      const counts = new Map();
      for (const el of nodes) {
        const role = (el.getAttribute('role') || '').trim().toLowerCase();
        if (!role) continue;
        counts.set(role, (counts.get(role) || 0) + 1);
      }
      const entries = Array.from(counts.entries()).map(([role, count]) => ({ role, count }));
      entries.sort((a, b) => b.count - a.count);
      return entries.slice(0, 30);
    })();

    const counts = {
      images: imageSummary.total,
      frames: frameSummary.total,
      links: linkSummary.total,
      formControls: formSummary.controlsTotal,
      headings: headingsSummary.total,
      listItems: listSummary.total,
      langChanges: langChanges.length,
      dirChanges: dirChanges.length,
      tables: tableSummary.total,
      fieldsets: formSummary.fieldsetCount,
      buttons: buttons.length,
      landmarks: landmarks.length,
      focusables: focusables.length
    };

    const partial = !collectArrays
      || imageSummary.total > ${maxImages}
      || linkSummary.total > ${maxLinks}
      || listSummary.total > ${maxListItems}
      || formSummary.controlsTotal > ${maxFormControls}
      || headingsSummary.total > ${maxHeadings}
      || buttons.length > ${maxButtons}
      || landmarks.length > ${maxLandmarks}
      || focusables.length > ${maxFocusables}
      || tableSummary.total > ${maxTables}
      || formSummary.fieldsetCount > ${maxFieldsets};

    if (${countsOnly}) {
      return {
        doctype,
        title,
        lang,
        href,
        readyState,
        dir,
        counts,
        partial,
        imageSummary,
        frameSummary,
        linkSummary,
        listSummary,
        headingAnalysis,
        headingsSummary,
        tableSummary,
        formSummary,
        focusableSummary,
        ariaLive,
        ariaSummary,
        rolesSummary,
        meta,
        linkSummary,
        media,
        mediaDetails,
        visual,
        scripts
      };
    }

    return {
      doctype,
      title,
      lang,
      href,
      readyState,
      counts,
      partial,
      imageSummary,
      frameSummary,
      linkSummary,
      listSummary,
      headingAnalysis,
      images: cap(images, ${maxImages}),
      frames: cap(frames),
      links: cap(links, ${maxLinks}),
      formControls: cap(formControls, ${maxFormControls}),
      headings: cap(headings, ${maxHeadings}),
      headingsSummary,
      listItems: cap(listItems, ${maxListItems}),
      langChanges: cap(langChanges),
      dir,
      dirChanges: cap(dirChanges),
      tables: cap(tables, ${maxTables}),
      tableSummary,
      fieldsets: cap(fieldsets, ${maxFieldsets}),
      formSummary,
      buttons: cap(buttons, ${maxButtons}),
      landmarks: cap(landmarks, ${maxLandmarks}),
      focusables: cap(focusables, ${maxFocusables}),
      focusableSummary,
      ariaLive,
      ariaSummary,
      rolesSummary: cap(rolesSummary, ${maxItems}),
      meta: cap(meta, ${maxItems}),
      linkSummary: cap(linkSummary, ${maxItems}),
      media: cap(media, ${maxItems}),
      mediaDetails,
      visual,
      scripts: cap(scripts, ${maxItems})
    };
  })();`;
}
