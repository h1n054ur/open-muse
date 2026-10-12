/**
 * open-muse — OpenCode plugin entrypoint.
 *
 *   { "plugin": ["open-muse"] }
 *
 * On load it starts a local OpenAI-compatible proxy (one per OpenCode process)
 * backed by the Muse Code CLI's `muse serve`, registers a `muse` provider that
 * points at it, and tags each request with the OpenCode session, agent and
 * directory so the proxy can keep one Muse session per OpenCode session.
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { createLogger, resolveConfig, type OpenMuseConfig } from "./config.js";
import { toOpencodeModels } from "./muse/models.js";
import { HEADER_AGENT, HEADER_DIRECTORY, HEADER_SESSION, startProxy, type ProxyServer } from "./proxy/server.js";

const SHARED = Symbol.for("open-muse.proxy");
type Shared = { proxy: Promise<ProxyServer>; users: number };

/** OpenCode creates a plugin instance per project; they all share one proxy and one `muse serve`. */
function acquireProxy(config: OpenMuseConfig): Promise<ProxyServer> {
  const g = globalThis as { [SHARED]?: Shared };
  if (!g[SHARED]) {
    const proxy = startProxy(config);
    proxy.catch(() => delete g[SHARED]);
    g[SHARED] = { proxy, users: 0 };
  }
  g[SHARED].users++;
  return g[SHARED].proxy;
}

async function releaseProxy(): Promise<void> {
  const g = globalThis as { [SHARED]?: Shared };
  const shared = g[SHARED];
  if (!shared || --shared.users > 0) return;
  delete g[SHARED];
  await (await shared.proxy).close();
}

// Only the default export: OpenCode 1.x also calls every exported function as a plugin.
const OpenMusePlugin: Plugin = async (input: PluginInput, options?: Record<string, unknown>): Promise<Hooks> => {
  const config = resolveConfig(options);
  const log = createLogger(config);
  const proxy = await acquireProxy(config);

  // Pick up the account's real model list in the background; it's used from the next start.
  if (proxy.catalog.stale) {
    proxy.catalog.refresh().catch((error) => log.debug("model refresh skipped:", error instanceof Error ? error.message : error));
  }

  return {
    async config(cfg) {
      const providers = ((cfg as any).provider ??= {}) as Record<string, any>;
      const existing = providers[config.providerId] ?? {};
      providers[config.providerId] = {
        name: "Muse Code",
        npm: "@ai-sdk/openai-compatible",
        ...existing,
        options: {
          ...(existing.options ?? {}),
          baseURL: proxy.url,
          // The proxy is local and uses the muse CLI's own sign-in; this value is never checked.
          apiKey: "open-muse",
        },
        models: { ...toOpencodeModels(proxy.catalog.models), ...(existing.models ?? {}) },
      };
    },

    async "chat.headers"(req, out) {
      const providerId = (req.model as any)?.providerID ?? req.provider?.info?.id;
      if (providerId !== config.providerId) return;
      out.headers[HEADER_SESSION] = req.sessionID;
      out.headers[HEADER_AGENT] = req.agent;
      out.headers[HEADER_DIRECTORY] = input.directory;
    },

    async dispose() {
      await releaseProxy();
    },
  };
};

export default { id: "open-muse", server: OpenMusePlugin };
