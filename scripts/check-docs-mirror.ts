/**
 * Guards the hand-mirrored documentation pairs.
 *
 * `docs/` is the source of truth; `docs-site/` is the published Mintlify
 * site. Seven pages exist in both trees and are kept in sync by hand, so they
 * drift silently — by 2026-07-28 the published `postgres` and
 * `reference-platform` pages had fallen far enough behind to state things that
 * were no longer true (Postgres mode described as lacking the admin service
 * suite that PLA-415 shipped; the Admin described as read-only).
 *
 * The generated mirror `docs-site/api-reference/openapi.yaml` cannot rot,
 * because `npm run spec:check` diffs it. This applies the same idea to the
 * prose pairs, without pretending the two files should be identical: the MDX
 * copies legitimately carry front matter, Mintlify components, and their own
 * phrasing. What we can check is that a change to one side is accompanied by a
 * change to the other in the same commit range.
 *
 * Usage:
 *   tsx scripts/check-docs-mirror.ts            # verify pairs exist
 *   tsx scripts/check-docs-mirror.ts --since <ref>   # also check co-modification
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** The hand-mirrored pages: repo source → published page. */
const MIRRORED_PAGES: ReadonlyArray<{ source: string; published: string }> = [
  { source: "docs/ai-prompts.md", published: "docs-site/guides/ai-prompts.mdx" },
  { source: "docs/customer-identity.md", published: "docs-site/guides/customer-identity.mdx" },
  { source: "docs/postgres.md", published: "docs-site/guides/postgres.mdx" },
  // These two pairs carry different file names on each side, which is exactly
  // why they were missed on the first pass — nothing links them but intent.
  { source: "docs/punchh-compatibility.md", published: "docs-site/guides/punchh-migration.mdx" },
  { source: "docs/quickstart.md", published: "docs-site/get-started/quickstart.mdx" },
  { source: "docs/reference-platform.md", published: "docs-site/guides/reference-platform.mdx" },
  { source: "docs/typescript-sdk.md", published: "docs-site/guides/typescript-sdk.mdx" },
  { source: "docs/using-lip-with-ai.md", published: "docs-site/guides/using-lip-with-ai.mdx" },
  { source: "docs/webhook-delivery.md", published: "docs-site/guides/webhooks.mdx" }
];

function changedFiles(since: string): ReadonlySet<string> {
  const output = execFileSync("git", ["diff", "--name-only", `${since}...HEAD`], {
    encoding: "utf8"
  });
  return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean));
}

function main(): void {
  const failures: string[] = [];

  // Every declared pair must exist. A rename that updates only one side would
  // otherwise silently disable the co-modification check below.
  for (const { source, published } of MIRRORED_PAGES) {
    if (!existsSync(source)) failures.push(`missing source page: ${source}`);
    if (!existsSync(published)) failures.push(`missing published page: ${published}`);
  }

  const sinceFlag = process.argv.indexOf("--since");
  if (sinceFlag !== -1 && failures.length === 0) {
    const since = process.argv[sinceFlag + 1];
    if (!since) {
      console.error("--since requires a git ref");
      process.exit(2);
    }
    const changed = changedFiles(since);
    for (const { source, published } of MIRRORED_PAGES) {
      const sourceChanged = changed.has(source);
      const publishedChanged = changed.has(published);
      if (sourceChanged && !publishedChanged) {
        failures.push(
          `${source} changed but ${published} did not — the published page ` +
          `will drift. Mirror the change, or state in the PR why the ` +
          `published copy should differ.`
        );
      }
      if (publishedChanged && !sourceChanged) {
        failures.push(
          `${published} changed but ${source} did not — ${source} is the ` +
          `source of truth. Update it too, or explain the divergence.`
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error("Documentation mirror check failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      "\ndocs/ is the source of truth; docs-site/ is the published Mintlify " +
      "site.\nSee scripts/check-docs-mirror.ts for the tracked pairs."
    );
    process.exit(1);
  }

  console.log(`Documentation mirror OK (${MIRRORED_PAGES.length} pairs).`);
}

main();
