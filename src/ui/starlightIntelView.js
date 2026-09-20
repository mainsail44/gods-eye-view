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
  return [
    health.model,
    `corpus ${health.corpusVersion || 'unknown'}${checksum}`,
    `egress ${health.egress}`,
  ].join(SEPARATOR);
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
  const documentRef = element.ownerDocument;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = input.value;
    // Clear before handing the question over: the ask is asynchronous and the
    // operator is already free to type the next one.
    input.value = '';
    onAsk(question);
  });

  return {
    /** Paint one panel state; hidden whenever the component is toggled off. */
    render({ enabled, health, answer, status }) {
      element.hidden = !enabled;
      statusNode.textContent = status;
      metaNode.textContent = describeIntelHealth(health);
      answerNode.textContent = answer.answer;
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
        return item;
      });
      citationList.replaceChildren(...items);
    },
  };
}
