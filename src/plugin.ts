/**
 * open-muse — OpenCode plugin entrypoint, for OpenCode 1.x and 2.x.
 *
 *   OpenCode 1.x: { "plugin": ["open-muse"] }   → calls `server`
 *   OpenCode 2.x: { "plugins": ["open-muse"] }  → loads `exports["./server"]`, calls `setup`
 *
 * On load it starts a local OpenAI-compatible proxy (one per OpenCode process)
 * backed by the Muse Code CLI's `muse serve`, registers a `muse` provider that
 * points at it, and tags each request with the OpenCode session, agent and
 * directory so the proxy can keep one Muse session per OpenCode session.
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { createLogger, resolveConfig, type OpenMuseConfig } from "./config.js";
import { toOpencode2Models, toOpencodeModels } from "./muse/models.js";
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

/**
 * The slice of OpenCode 2's plugin context we use. Duck-typed rather than importing
 * `@opencode/plugin`, which would pull the whole 2.x host type graph into a 1.x build.
 */
interface Registration {
  dispose(): Promise<void>;
}
interface ModelRequest {
  readonly sessionID: string;
  readonly agent: string;
  readonly kind: "primary" | "compaction" | "title" | "generate";
  headers: Record<string, string>;
}
interface Opencode2Context {
  readonly location?: { readonly directory?: string };
  readonly options?: Record<string, unknown>;
  readonly provider: {
    transform(callback: (editor: { add(input: { info: unknown; models: readonly unknown[] }): void }) => void): Promise<Registration>;
    reload(): Promise<void>;
  };
  readonly session: {
    get(input: { sessionID: string }): Promise<{ location?: { directory?: string } }>;
    hook(name: "model.request", callback: (event: ModelRequest) => Promise<void> | void, options?: { providerID?: string }): Promise<Registration>;
  };
}

/** OpenCode 2: providers are registered in memory, not through the config. */
async function setup(ctx: Opencode2Context): Promise<() => Promise<void>> {
  const config = resolveConfig(ctx.options);
  const log = createLogger(config);
  const proxy = await acquireProxy(config);
  const registrations: Registration[] = [];
  try {
    // Replayed on every provider.reload(); user `providers.muse` settings from the config are layered on top by the host.
    registrations.push(
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            id: config.providerId,
            name: "Muse Code",
            activation: "enabled",
            // OpenCode 2's built-in Chat Completions client; it only maps the @ai-sdk name for known providers.
            package: "@opencode/ai/providers/openai-compatible",
            // The proxy is local and uses the muse CLI's own sign-in; the key is never checked.
            settings: { baseURL: proxy.url, apiKey: "open-muse" },
          },
          models: toOpencode2Models(proxy.catalog.models, config.providerId),
        });
      }),
    );

    registrations.push(
      await ctx.session.hook(
        "model.request",
        async (event) => {
          // The OpenCode 2 daemon serves many projects, so ask for this session's directory.
          const directory =
            (await ctx.session.get({ sessionID: event.sessionID }).then((s) => s.location?.directory, () => undefined)) ??
            ctx.location?.directory;
          event.headers = {
            ...event.headers,
            [HEADER_SESSION]: event.sessionID,
            // Title and compaction requests run under the session's agent; the proxy needs to know what they are.
            [HEADER_AGENT]: event.kind === "primary" ? event.agent : event.kind,
            ...(directory ? { [HEADER_DIRECTORY]: directory } : {}),
          };
        },
        { providerID: config.providerId },
      ),
    );
  } catch (error) {
    await Promise.all(registrations.map((r) => r.dispose().catch(() => undefined)));
    await releaseProxy();
    throw error;
  }

  if (proxy.catalog.stale) {
    proxy.catalog
      .refresh()
      .then(() => ctx.provider.reload())
      .catch((error) => log.debug("model refresh skipped:", error instanceof Error ? error.message : error));
  }

  return async () => {
    await Promise.all(registrations.map((r) => r.dispose().catch(() => undefined)));
    await releaseProxy();
  };
}

export default { id: "open-muse", server: OpenMusePlugin, setup };
