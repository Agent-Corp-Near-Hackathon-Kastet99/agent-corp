import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT } from "../config.js";

export type Brief = {
  product: { name: string; pitch: string; price: string; url: string };
  icp: { primary: string; secondary?: string; pains: string[] };
  channels: string[];
  funnel: string[];
  voice: { tone: string; avoid: string[] };
  visual: { style: string; palette: string };
  constraints: { legal: string; label: string };
};

const fail = (msg: string): never => { throw new Error(`growth/brief.yaml: ${msg}`); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim()) fail(`${name} must be a non-empty string`);
  return (v as string).trim();
};
const list = (v: unknown, name: string) => {
  if (!Array.isArray(v) || v.length === 0 || !v.every(s => typeof s === "string" && s.trim())) fail(`${name} must be a non-empty list of strings`);
  return (v as string[]).map(s => s.trim());
};

export function validateBrief(value: unknown): Brief {
  if (!isObject(value)) return fail("expected mapping");
  const { product, icp, voice, visual, constraints } = value;
  if (!isObject(product) || !isObject(icp) || !isObject(voice) || !isObject(visual) || !isObject(constraints)) {
    return fail("product, icp, voice, visual and constraints must be mappings");
  }
  const url = text(product.url, "product.url");
  let protocol: string | undefined;
  try { protocol = new URL(url).protocol; } catch { /* reported below */ }
  if (protocol === undefined) fail("product.url must be a valid URL");
  if (protocol !== "http:" && protocol !== "https:") fail("product.url must be http(s)");
  return {
    product: { name: text(product.name, "product.name"), pitch: text(product.pitch, "product.pitch"), price: text(product.price, "product.price"), url },
    icp: {
      primary: text(icp.primary, "icp.primary"),
      secondary: icp.secondary === undefined ? undefined : text(icp.secondary, "icp.secondary"),
      pains: list(icp.pains, "icp.pains"),
    },
    channels: list(value.channels, "channels"),
    funnel: list(value.funnel, "funnel"),
    voice: { tone: text(voice.tone, "voice.tone"), avoid: voice.avoid === undefined ? [] : list(voice.avoid, "voice.avoid") },
    visual: { style: text(visual.style, "visual.style"), palette: text(visual.palette, "visual.palette") },
    constraints: { legal: text(constraints.legal, "constraints.legal"), label: text(constraints.label, "constraints.label") },
  };
}

export function loadBrief(file = join(ROOT, "growth", "brief.yaml")): Brief {
  return validateBrief(parse(readFileSync(file, "utf8")));
}

/** True while the owner has not replaced the placeholder URL. Live publishing must refuse until false. */
export const hasPlaceholderUrl = (brief: Brief) => /REPLACE-ME/i.test(brief.product.url);
