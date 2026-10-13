import { codex } from "./codex.mjs";
import { claude } from "./claude.mjs";
import { cursor } from "./cursor.mjs";
import { grok } from "./grok.mjs";
import { codexapp } from "./codexapp.mjs";

export const ADAPTERS = { codex, claude, cursor, grok, codexapp };
export const AGENT_IDS = Object.keys(ADAPTERS);

export async function detectAgents(agentConfig = {}, adapters = ADAPTERS) {
  const found = await Promise.all(
    Object.keys(adapters).map(async (id) => {
      try {
        return [id, { ...(await adapters[id].detect(agentConfig[id] ?? {})), tested: adapters[id].tested }];
      } catch (error) {
        return [id, { installed: false, error: String(error.message ?? error), tested: adapters[id].tested }];
      }
    }),
  );
  return Object.fromEntries(found); // always in adapter order
}
