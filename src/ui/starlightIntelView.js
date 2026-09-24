/**
 * DOM binding for the Starlight Local Intel panel. It holds no application
 * state: every paint comes from a state object the panel hands over, and the
 * only things it reports back are the operator's two intents — asking a
 * question and clicking a citation.
 *
 * Everything the service returns is untrusted text. Every write here goes
 * through `textContent`, never markup, so an answer or a citation label can
 * contain anything without reaching the parser.
 */

/** The status line's separator, shared with the layer panel's meta line. */
const SEPARATOR = ' · ';
// Enough checksum to tell two corpus builds apart at a glance, short enough to
// sit on one line beside the version.
const CHECKSUM_CHARS = 8;

const STEP_NAMES = Object.freeze({
  read: 'Read',
  resolve: 'Place',
  retrieve: 'Retrieve',
  answer: 'Answer',
});

/**
 * Describe live service health on one line. A service that is not reporting
 * has nothing truthful to say about the model or the corpus, so it says
 * nothing and the status line alone carries the outage.
 * @param {{ok:boolean,model:string,corpusVersion:string,corpusChecksum:string,egress:string}} health
 * @returns {string}
 */
export function describeIntelHealth(health) {
  if (!health?.ok) return '';
  const checksum = health.corpusChecksum
    ? ` ${health.corpusChecksum.slice(0, CHECKSUM_CHARS)}`
    : '';
  const vectors = health.embeddingModel
    ? health.embeddingsReady
      ? `vectors ${health.embeddingModel}`
      : `vectors indexing ${health.embeddingsIndexed || 0}`
    : '';
  return [
    health.model,
    `corpus ${health.corpusVersion || 'unknown'}${checksum}`,
    vectors,
    `egress ${health.egress}`,
  ]
    .filter(Boolean)
    .join(SEPARATOR);
}

/**
 * One line on how the question was read and where it was placed: the
 * model's reading first, then the gazetteer's verdict on it.
 * @param {{reading: object, place: object|null}} answer
 * @returns {string}
 */
export function describeIntelReading({ reading, place } = {}) {
  const asked = [reading?.place, reading?.region, reading?.country]
    .filter(Boolean)
    .join(', ');
  const kind =
    reading?.entityType && reading.entityType !== 'any'
      ? `${reading.entityType}s`
      : '';
  const parts = [];
  if (place) {
    const where = [place.name, place.region, place.country]
      .filter(Boolean)
      .join(', ');
    parts.push(
      `${place.confidence === 'ambiguous' ? 'Assumed' : 'Placed'} ${where}` +
        (place.radiusKm ? ` (±${Math.round(place.radiusKm)} km)` : ''),
    );
  } else if (asked) parts.push(`Read as ${asked}, not in the gazetteer`);
  if (kind) parts.push(kind);
  if (reading?.operator) parts.push(reading.operator);
  if (reading?.radiusKm) parts.push(`within ${reading.radiusKm} km`);
  return parts.join(SEPARATOR);
}

/** A citation's second line: where it is and why it was retrieved. */
export function describeIntelCitation(citation) {
  const parts = [];
  if (citation.kind === 'landing-point') parts.push('landing point');
  const where = [citation.city, citation.region].filter(Boolean).join(', ');
  if (where) parts.push(where);
  else if (citation.country) parts.push(citation.country);
  if (Number.isFinite(citation.why?.km)) parts.push(`${citation.why.km} km`);
  return parts.join(SEPARATOR);
}

/** One trace step, as the panel prints it: "Read 2.4 s · Woodbridge, Virginia". */
export function describeIntelStep(step) {
  const seconds =
    step.ms >= 1000
      ? `${(step.ms / 1000).toFixed(1)} s`
      : `${Math.round(step.ms)} ms`;
  const name = STEP_NAMES[step.step] ?? step.step;
  return step.detail
    ? `${name} ${seconds}${SEPARATOR}${step.detail}`
    : `${name} ${seconds}`;
}

/**
 * Bind the panel markup once and repaint it on demand.
 * @param {object} options
 * @param {HTMLElement} options.element Panel root carrying the data-intel hooks.
 * @param {(question: string) => void} [options.onAsk] The operator submitted a question.
 * @param {(citation: object) => void} [options.onCiteClick] The operator chose a citation.
 * @returns {{render: (state: object) => void}}
 */
export function createStarlightIntelView({
  element,
  onAsk = () => {},
  onCiteClick = () => {},
}) {
  if (!element)
    throw new TypeError('A Starlight Local Intel element is required');
  const find = (selector) => {
    const node = element.querySelector(selector);
    if (!node)
      throw new TypeError(
        `Starlight Local Intel markup is missing ${selector}`,
      );
    return node;
  };
  const statusNode = find('[data-intel-status]');
  const metaNode = find('[data-intel-meta]');
  const answerNode = find('[data-intel-answer]');
  const citationList = find('[data-intel-citations]');
  const form = find('[data-intel-form]');
  const input = find('[data-intel-input]');
  // Newer markup only; a shell without them simply shows less.
  const readingNode = element.querySelector('[data-intel-reading]');
  const traceList = element.querySelector('[data-intel-trace]');
  const documentRef = element.ownerDocument;

  // Minimize folds the panel to its title row; the choice is remembered per
  // browser so a presenter's layout survives a reload.
  const MINIMIZED_KEY = 'starlight-intel:minimized';
  const minimizeButton = element.querySelector('[data-intel-minimize]');
  const setMinimized = (minimized) => {
    element.classList.toggle('is-minimized', minimized);
    if (minimizeButton) {
      minimizeButton.setAttribute('aria-expanded', String(!minimized));
      minimizeButton.title = minimized ? 'Expand' : 'Minimize';
      minimizeButton.textContent = minimized ? '+' : '\u2013';
    }
    try {
      documentRef.defaultView?.localStorage?.setItem(MINIMIZED_KEY, minimized ? '1' : '0');
    } catch {
      /* storage is a convenience */
    }
  };
  if (minimizeButton) {
    let remembered = false;
    try {
      remembered = documentRef.defaultView?.localStorage?.getItem(MINIMIZED_KEY) === '1';
    } catch {
      /* ignore */
    }
    setMinimized(remembered);
    minimizeButton.addEventListener('click', () =>
      setMinimized(!element.classList.contains('is-minimized')),
    );
  }
  // The panel repaints on every health poll (5 s). The answer object only
  // changes when a new answer lands, so rebuild the citation buttons only
  // then: replacing them on every poll drops a click that straddles the
  // repaint and steals keyboard focus from whichever citation held it.
  let paintedAnswer = null;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = input.value;
    // Clear before handing the question over: the ask is asynchronous and the
    // operator is already free to type the next one.
    input.value = '';
    onAsk(question);
  });

  const paintCitations = (answer) => {
    const items = answer.citations.map((citation) => {
      // A real button, not a click handler on a bare list item, so the
      // citation is reachable by keyboard and announced as an action.
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'starlight-intel-citation';
      button.textContent = citation.label || citation.id;
      button.addEventListener('click', () => onCiteClick(citation));
      const item = documentRef.createElement('li');
      item.appendChild(button);
      const detail = describeIntelCitation(citation);
      if (detail) {
        const small = documentRef.createElement('small');
        small.className = 'starlight-intel-citation-detail';
        small.textContent = detail;
        item.appendChild(small);
      }
      return item;
    });
    citationList.replaceChildren(...items);
  };

  // One strip of "Read 2.4 s · Place 0 ms · …": the timings are the point,
  // the detail of each step is a hover away, and the strip never pushes the
  // citations out of the panel's height.
  const paintTrace = (answer) => {
    if (!traceList) return;
    const steps = answer.trace ?? [];
    traceList.hidden = steps.length === 0;
    traceList.replaceChildren(
      ...steps.map((step) => {
        const item = documentRef.createElement('li');
        item.className = `starlight-intel-step starlight-intel-step-${step.step}`;
        item.textContent = describeIntelStep({ ...step, detail: '' });
        if (step.detail) item.title = step.detail;
        return item;
      }),
    );
  };

  const paintReading = (answer) => {
    if (!readingNode) return;
    const line = describeIntelReading(answer);
    readingNode.hidden = !line;
    readingNode.textContent = line;
  };

  // Quantum link key line and its fold-out entropy detail.
  const qkeyButton = element.querySelector('[data-intel-qkey]');
  const qkeyDetail = element.querySelector('[data-intel-qkey-detail]');
  let qkeyOpen = false;
  if (qkeyButton && qkeyDetail)
    qkeyButton.addEventListener('click', () => {
      qkeyOpen = !qkeyOpen;
      qkeyButton.setAttribute('aria-expanded', String(qkeyOpen));
      qkeyDetail.hidden = !qkeyOpen;
    });
  const paintQkey = (health) => {
    if (!qkeyButton || !qkeyDetail) return;
    const secure = health?.qryptStatus === 'secure';
    const mismatch = health?.qryptStatus === 'mismatch';
    qkeyButton.hidden = !(secure || mismatch);
    qkeyButton.dataset.state = secure ? 'secure' : 'mismatch';
    qkeyButton.textContent = secure
      ? `\u{1F512} Qrypt quantum key ${health.qryptFingerprint.slice(0, 8)} \u00b7 ${health.qryptCipher || 'AES-256-GCM'} \u00b7 ${qkeyOpen ? 'less' : 'details'}`
      : '\u{1F513} Qrypt quantum key MISMATCH';
    if (!secure) {
      qkeyDetail.hidden = true;
      return;
    }
    const age = health.qryptRotatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(health.qryptRotatedAt)) / 1000)) : null;
    const rows = [
      ['Protocol', health.qryptProtocol || 'Qrypt BLAST'],
      ['Cipher', `${health.qryptCipher || 'AES-256-GCM'}, ${health.qryptKeyBits || 256}-bit key, fresh nonce per message`],
      ['Entropy', `${health.qryptSources} QDEA sources, ${health.qryptRegion || 'aws-eastus'}`],
      ['Sampled', health.qryptSourcesDetail.map((s) => `${s.host.replace('-aws-eastus.qrypt.com', '')} ${s.ms} ms`).join(' \u00b7 ') || '\u2014'],
      ['Derivation', `app gen_init_otp ${health.qryptInitMs} ms \u00b7 intel gen_sync ${health.qryptSyncMs} ms`],
      ['Metadata', `${health.qryptMetadataBytes} bytes crossed the link; the key never did`],
      ['Key age', age === null ? '\u2014' : `${age} s, TTL ${health.qryptTtl} s, next rotation ${health.qryptNextRotationAt.replace('T', ' ').slice(11, 16)}Z`],
      ['SDK', health.qryptSdk || '\u2014'],
    ];
    qkeyDetail.replaceChildren(
      ...rows.flatMap(([term, value]) => {
        const dt = documentRef.createElement('dt');
        dt.textContent = term;
        const dd = documentRef.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
      }),
    );
  };

  return {
    /** Paint one panel state; hidden whenever the component is toggled off. */
    render({ enabled, health, answer, status }) {
      element.hidden = !enabled;
      statusNode.textContent = status;
      metaNode.textContent = describeIntelHealth(health);
      paintQkey(health);
      answerNode.textContent = answer.answer;
      if (answer === paintedAnswer) return;
      paintedAnswer = answer;
      paintReading(answer);
      paintCitations(answer);
      paintTrace(answer);
    },
  };
}
