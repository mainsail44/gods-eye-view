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
  let queryController = null;
  let health = OFFLINE;
  let answer = EMPTY;
  let status = 'Disabled';
  let generation = 0;

  const render = () => onRender({ enabled, health, answer, status });

  const poll = async () => {
    if (!enabled) return;
    const mine = generation;
    controller = new AbortController();
    try {
      const result = normalizeIntelHealth(
        await transport.health(controller.signal),
      );
      if (mine !== generation) return;
      health = result;
      status = health.ok ? 'Local' : 'Intel service unavailable';
    } catch {
      if (mine !== generation) return;
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
      generation += 1;
      status = 'Connecting';
      render();
      void poll();
    },

    disable() {
      if (!enabled) return;
      enabled = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
      controller = null;
      queryController?.abort();
      queryController = null;
      health = OFFLINE;
      answer = EMPTY;
      status = 'Disabled';
      render();
    },

    async ask(question) {
      if (!enabled) return;
      const mine = generation;
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
      if (queryController) queryController.abort();
      queryController = new AbortController();
      try {
        const result = normalizeIntelAnswer(
          await transport.query(body, queryController.signal),
        );
        if (mine !== generation) return;
        answer = result;
        status = health.ok ? 'Local' : 'Local (health unknown)';
        for (const cite of answer.citations) onCite(cite);
      } catch {
        if (mine !== generation) return;
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
