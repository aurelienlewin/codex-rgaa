export function getSnapshotExpression() {
  return `(() => {
    const doc = document;
    const html = doc.documentElement;

    const doctype = doc.doctype ? doc.doctype.name : '';
    const title = doc.title || '';
    const lang = (html && html.getAttribute('lang')) || '';
    const href = String(location && location.href ? location.href : '');
    const readyState = doc.readyState || '';

    const getText = (node) => (node ? (node.textContent || '') : '');
    const getLabelledBy = (el) => {
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      return ids.map((id) => getText(doc.getElementById(id))).join(' ').trim();
    };

    const getAccessibleName = (el) => {
      const ariaLabel = (el.getAttribute('aria-label') || '').trim();
      if (ariaLabel) return ariaLabel;
      const labelledBy = getLabelledBy(el);
      if (labelledBy) return labelledBy;

      if (el.tagName === 'IMG') {
        const alt = el.getAttribute('alt');
        if (alt !== null) return alt.trim();
      }

      const text = (el.textContent || '').trim();
      if (text) return text;

      const titleAttr = (el.getAttribute('title') || '').trim();
      if (titleAttr) return titleAttr;

      return '';
    };

    const images = Array.from(doc.querySelectorAll('img, [role="img"]')).map((el) => {
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const ariaHidden = (el.getAttribute('aria-hidden') || '').toLowerCase() === 'true';
      const alt = el.getAttribute('alt');
      const name = getAccessibleName(el);
      return {
        tag,
        role,
        ariaHidden,
        alt: alt === null ? null : String(alt),
        name
      };
    });

    const frames = Array.from(doc.querySelectorAll('iframe, frame')).map((el) => {
      return {
        title: (el.getAttribute('title') || '').trim(),
        ariaLabel: (el.getAttribute('aria-label') || '').trim(),
        ariaLabelledby: (el.getAttribute('aria-labelledby') || '').trim()
      };
    });

    const links = Array.from(doc.querySelectorAll('a[href]')).map((el) => {
      const name = getAccessibleName(el);
      return {
        href: el.getAttribute('href') || '',
        name,
        rawText: (el.textContent || '').trim(),
        title: (el.getAttribute('title') || '').trim(),
        ariaLabel: (el.getAttribute('aria-label') || '').trim(),
        ariaLabelledby: (el.getAttribute('aria-labelledby') || '').trim()
      };
    });

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
        if (label) return (label.textContent || '').trim();
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return (parentLabel.textContent || '').trim();
      return '';
    };

    const formControls = Array.from(doc.querySelectorAll('input, select, textarea, button'))
      .filter(isFormControl)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase(),
        id: el.getAttribute('id') || '',
        name: el.getAttribute('name') || '',
        label: getControlLabel(el)
      }));

    const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((el) => ({
      level: Number(el.tagName.replace('H', '')),
      text: (el.textContent || '').trim()
    }));

    const listItems = Array.from(doc.querySelectorAll('li')).map((el) => {
      const parent = el.parentElement ? el.parentElement.tagName.toLowerCase() : '';
      return { parent };
    });

    const langChanges = Array.from(doc.querySelectorAll('[lang]'))
      .map((el) => (el.getAttribute('lang') || '').trim())
      .filter((val) => val && val !== lang);

    const tables = Array.from(doc.querySelectorAll('table')).map((table) => {
      const hasTh = !!table.querySelector('th');
      const hasCaption = !!table.querySelector('caption');
      return { hasTh, hasCaption };
    });

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

    return {
      doctype,
      title,
      lang,
      href,
      readyState,
      images,
      frames,
      links,
      formControls,
      headings,
      listItems,
      langChanges,
      tables,
      media,
      visual,
      scripts
    };
  })();`;
}

export async function collectSnapshot(client) {
  const { Runtime } = client;
  const expression = getSnapshotExpression();

  const { result } = await Runtime.evaluate({
    expression,
    returnByValue: true
  });

  return result.value;
}
