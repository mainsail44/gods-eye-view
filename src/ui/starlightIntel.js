import {
  normalizeIntelHealth,
  normalizeIntelAnswer,
  buildIntelQueryBody,
} from '../sources/intel.js';

const OFFLINE = normalizeIntelHealth(null);
const EMPTY = normalizeIntelAnswer(null);

/**
 * Behavior of the Starlight Local Intel component. Disabled is genuinely off:
 * polling stops, in-flight work aborts, and nothing reaches the network.
 */
export function createStarlightIntelPanel({
  transport,
  pollMs = 5_000,
  onRender = () => {},
  onCite = () => {},
}) {
  let enabled = false;
  let timer = null;
  let controller = null;
  let health = OFFLINE;
  let answer = EMPTY;
  let status = 'Disabled';

  const render = () => onRender({ enabled, health, answer, status });

  const poll = async () => {
    if (!enabled) return;
    controller = new AbortController();
    try {
      health = normalizeIntelHealth(await transport.health(controller.signal));
      status = health.ok ? 'Local' : 'Intel service unavailable';
    } catch {
      health = OFFLINE;
      status = 'Intel service unavailable';
    }
    if (!enabled) return;
    render();
    timer = setTimeout(poll, pollMs);
  };

  return {
    enable() {
      if (enabled) return;
      enabled = true;
      status = 'Connecting';
      render();
      void poll();
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
      controller = null;
      health = OFFLINE;
      answer = EMPTY;
      status = 'Disabled';
      render();
    },

    async ask(question) {
      if (!enabled) return;
      let body;
      try {
        body = buildIntelQueryBody(question);
      } catch {
        status = 'Ask a question first';
        render();
        return;
      }
      status = 'Thinking';
      render();
      const queryController = new AbortController();
      try {
        answer = normalizeIntelAnswer(
          await transport.query(body, queryController.signal),
        );
        status = health.ok ? 'Local' : 'Local (health unknown)';
        for (const cite of answer.citations) onCite(cite);
      } catch {
        answer = EMPTY;
        status = 'Intel service unavailable';
      }
      render();
    },

    state() {
      return { enabled, health, answer, status };
    },
  };
}
