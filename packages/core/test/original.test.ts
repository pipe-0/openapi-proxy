import { describe, expect, it } from "vitest";
import { parseSpec, renderOriginalText, renderVariantText } from "../src/index.js";
import { loadFixtureText } from "./helpers.js";

const petstore = loadFixtureText("petstore-3.0.yaml");
const one = [{ name: "main", text: petstore }];

describe("what the original serves", () => {
  it("is the one document byte for byte, in its own format and version", () => {
    expect(renderOriginalText(one, { format: "yaml" })).toBe(petstore);
  });

  it("keeps what a variant that selects everything cuts away", () => {
    const original = parseSpec(renderOriginalText(one, { format: "json" })).doc;
    const everything = parseSpec(renderVariantText(one, { selection: {}, format: "json" })).doc;
    expect(original).toEqual(parseSpec(petstore).doc);
    // A tag no operation has is pruned from a variant, never from the original.
    const tags = (doc: Record<string, unknown>) =>
      (doc.tags as Array<{ name: string }>).map((tag) => tag.name);
    expect(tags(original)).toContain("unused");
    expect(tags(everything)).not.toContain("unused");
  });

  it("is converted when a version is asked for", () => {
    const converted = parseSpec(renderOriginalText(one, { format: "json", version: "3.1" })).doc;
    expect(converted.openapi).toMatch(/^3\.1/);
  });

  it("is the merge, as it is, for several documents", () => {
    const billing = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Billing", version: "1" },
      paths: { "/invoices": { get: { responses: { "200": { description: "ok" } } } } },
    });
    const merged = parseSpec(
      renderOriginalText(
        [
          { name: "main", text: petstore },
          { name: "billing", text: billing, pathPrefix: "/billing" },
        ],
        { format: "json" },
      ),
    ).doc;
    expect(Object.keys(merged.paths as object)).toContain("/billing/invoices");
    expect((merged.info as { title: string }).title).toBe("Petstore");
  });
});
