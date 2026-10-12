import fs from "node:fs";
import path from "node:path";
import type { MuseHost } from "./host.js";
import type { Logger, OpenMuseConfig } from "../config.js";

export interface MuseModel {
  id: string;
  name: string;
  context: number;
  output: number;
  efforts: string[];
  isDefault?: boolean;
}

/** Used until `muse serve` reports the real catalog for this account (then cached). */
const ALL_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const model = (id: string, efforts = ALL_EFFORTS): MuseModel => ({ id, name: id, context: 1_007_997, output: 128_000, efforts });
export const DEFAULT_MODELS: MuseModel[] = [
  { ...model("muse-wonder-1.0"), isDefault: true },
  model("muse-wonder-full-1.0"),
  model("muse-spark-1.3"),
  model("muse-spark-1.2", ALL_EFFORTS.slice(0, -1)),
];

export class ModelCatalog {
  #host: MuseHost;
  #log: Logger;
  #file: string;
  #models: MuseModel[];
  #cachedAt = 0;

  constructor(host: MuseHost, config: OpenMuseConfig, log: Logger) {
    this.#host = host;
    this.#log = log;
    this.#file = path.join(config.stateDir, "models.json");
    this.#models = this.#readCache() ?? DEFAULT_MODELS;
  }

  get models(): MuseModel[] {
    return this.#models;
  }

  /** True when there is no cached catalog from `muse serve`, or it is more than a day old. */
  get stale(): boolean {
    return Date.now() - this.#cachedAt > 24 * 60 * 60 * 1000;
  }

  /** Ask `muse serve` for the account's catalog and cache it for the next OpenCode start. */
  async refresh(): Promise<MuseModel[]> {
    const result = await this.#host.request("model/list", {});
    const rows = Array.isArray(result.models) ? (result.models as Record<string, any>[]) : [];
    const models = rows
      .filter((r) => typeof r.modelId === "string" && r.modelId)
      .map<MuseModel>((r) => ({
        id: r.modelId,
        name: typeof r.displayLabel === "string" && r.displayLabel ? r.displayLabel : r.modelId,
        context: typeof r.contextLimit === "number" ? r.contextLimit : 1_048_576,
        output: typeof r.outputLimit === "number" ? r.outputLimit : 131_072,
        efforts: Array.isArray(r.variants) ? r.variants.filter((v: unknown) => typeof v === "string" && v !== "none") : [],
        isDefault: r.isDefault === true,
      }));
    if (models.length > 0) {
      this.#models = models;
      this.#writeCache(models);
    }
    return this.#models;
  }

  #readCache(): MuseModel[] | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      this.#cachedAt = fs.statSync(this.#file).mtimeMs;
      return Array.isArray(parsed) && parsed.length > 0 ? (parsed as MuseModel[]) : undefined;
    } catch {
      return undefined;
    }
  }

  #writeCache(models: MuseModel[]): void {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(this.#file, JSON.stringify(models, null, 2));
      this.#cachedAt = Date.now();
    } catch (error) {
      this.#log.debug("could not cache model list", error);
    }
  }
}

/** The `models` block of an OpenCode provider entry. */
export function toOpencodeModels(models: MuseModel[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of models) {
    const variants: Record<string, unknown> = {};
    for (const effort of m.efforts) variants[effort] = { reasoningEffort: effort };
    out[m.id] = {
      name: m.name,
      reasoning: true,
      tool_call: false,
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: m.context, output: m.output },
      cost: { input: 0, output: 0 },
      ...(Object.keys(variants).length > 0 ? { variants } : {}),
    };
  }
  return out;
}
