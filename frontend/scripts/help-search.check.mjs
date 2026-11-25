// Self-check for the Help Center matcher. Run: node --experimental-strip-types scripts/help-search.check.mjs
import { rank, score, tokens } from "../src/apps/help/search.ts";
import { FAQS, TUTORIALS } from "../src/apps/help/content.ts";

const ok = (c, m) => {
  if (!c) throw new Error(m);
};
const fields = (t) => [[t.title, 3], [t.keywords, 2], [t.intro + " " + t.steps.map((s) => s.text).join(" "), 1]];
const top = (q) => rank(q, TUTORIALS, fields)[0]?.id;

ok(tokens("How do I use my NVIDIA graphics card?").includes("gpu"), "synonyms map to content words");
ok(score("", [["x", 1]]) === 0 && score("zzzz qqqq", [["vm disk", 3]]) === 0, "empty / unrelated query scores 0");
for (const [q, want] of [
  ["my updates fail with 401", "updates"],
  ["I want to use my graphics card in a windows vm", "gpu-passthrough"],
  ["block ads on my network", "adblock"],
  ["connect from my phone when I'm away", "vpn"],
  ["make a new virtual machine", "create-vm"],
  ["share a folder with my laptop", "share"],
  ["install plex", "apps"],
  ["turn on 2fa", "2fa"],
]) ok(top(q) === want, `"${q}" -> ${top(q)} (want ${want})`);
ok(rank("lost my phone 2fa code", FAQS, (f) => [[f.q, 3], [f.keywords, 2], [f.a, 1]])[0].q.includes("2FA"), "FAQ match");
ok(TUTORIALS.every((t) => t.steps.length && t.keywords) && new Set(TUTORIALS.map((t) => t.id)).size === TUTORIALS.length, "tutorial ids unique");
console.log(`help search self-check OK (${TUTORIALS.length} tutorials, ${FAQS.length} FAQs)`);
