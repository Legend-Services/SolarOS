import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Lightbulb, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { buildArticles, type Article, type ArticleCategory } from "../../data/knowledgeRegistry";
import { CATEGORIES } from "../settings/modules";
import { navigate, type Intents } from "../../lib/stores";
import { pulseAnchor } from "../../lib/hooks";
import { useTranslation } from "../../i18n";
import { useCapabilities } from "../../store/capabilitiesStore";
import { GlassButton, GlassInput } from "../../components/ui/GlassKit";

export type HelpTarget = Exclude<NonNullable<Intents["help"]>, string>;
const GROUPS: ArticleCategory[] = ["apps", ...CATEGORIES];
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** `text` with every word of `term` wrapped in a <mark>. */
function Hl({ text, term }: { text: string; term?: string }) {
  const words = (term ?? "").trim().split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.join("|")})`, "gi");
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i} className="search-mark">{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** A screenshot that hides itself when the docs were built without it. */
function Shot({ src, alt }: { src?: string; alt: string }) {
  const [ok, setOk] = useState(true);
  if (!src || !ok) return null;
  return <img src={src} alt={alt} loading="lazy" onError={() => setOk(false)} className="my-3 w-full rounded-xl border border-white/10 shadow-lg shadow-black/30" />;
}

/** Help & Support › Manual: category tree with an instant filter on the left, the article reader on the right. */
export default function Manual({ target }: { target: HelpTarget | null }) {
  const { t, language } = useTranslation();
  const caps = useCapabilities((s) => s.capabilities);
  const articles = useMemo(() => buildArticles(t).filter((a) => !a.requires || caps[a.requires]), [language, caps]); // eslint-disable-line react-hooks/exhaustive-deps
  const [id, setId] = useState(target?.article ?? articles[0]?.articleId);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<ArticleCategory>>(new Set());
  const [tree, setTree] = useState(true);
  const reader = useRef<HTMLDivElement>(null);
  const article = articles.find((a) => a.articleId === id) ?? articles[0];
  const term = target?.article === article?.articleId ? target.term : undefined;

  useEffect(() => {
    if (!target) return;
    setId(target.article);
    reader.current?.scrollTo({ top: 0 });
    if (target.section) pulseAnchor(reader.current, `section-${target.section}`);
  }, [target]);

  const f = norm(filter.trim());
  const shown = (a: Article) => !f || norm(`${a.mainTitle} ${a.keywords} ${a.sections.map((s) => `${s.subTitle} ${s.bodyText}`).join(" ")}`).includes(f);
  // Without a filter, control articles are listed only under the sub-module being read.
  const listed = (a: Article) =>
    f ? shown(a) : !a.relatedSubSectionId || a.relatedModuleId === article?.relatedModuleId;
  const label = (g: ArticleCategory) => (g === "apps" ? t("kb.group.apps") : t(`set.cat.${g}`));
  const toggle = (g: ArticleCategory) => setCollapsed((s) => (s.has(g) ? (s.delete(g), new Set(s)) : new Set(s.add(g))));
  const indent = (a: Article) => (a.relatedSubSectionId ? "pl-8" : a.relatedModuleId ? "pl-5" : "pl-2");

  return (
    <div className="-m-4 flex h-[calc(100%+2rem)]">
      {tree && (
        <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-black/15">
          <div className="relative p-2">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-4.5 -translate-y-1/2 text-slate-500" />
            <GlassInput className="w-full pl-8" placeholder={t("help.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t("help.filter")} />
          </div>
          <nav className="min-h-0 flex-1 overflow-auto px-2 pb-2" aria-label={t("help.manual")}>
            {GROUPS.map((g) => {
              const items = articles.filter((a) => a.category === g && listed(a));
              if (!items.length) return null;
              const closed = collapsed.has(g) && !f;
              return (
                <div key={g} className="mb-1">
                  <button onClick={() => toggle(g)} aria-expanded={!closed} className="flex w-full items-center gap-1 px-1 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-slate-500 uppercase hover:text-slate-300">
                    {closed ? <ChevronRight size={11} /> : <ChevronDown size={11} />} {label(g)}
                  </button>
                  {!closed &&
                    items.map((a) => (
                      <button
                        key={a.articleId}
                        onClick={() => setId(a.articleId)}
                        aria-current={a.articleId === article?.articleId}
                        className={`block w-full truncate rounded-lg py-1 pr-2 text-left text-xs transition ${indent(a)} ${a.articleId === article?.articleId ? "bg-white/12 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
                      >
                        {a.mainTitle}
                      </button>
                    ))}
                </div>
              );
            })}
            {!articles.some(shown) && <p className="px-2 py-6 text-center text-xs text-slate-500">{t("help.noArticles")}</p>}
          </nav>
        </aside>
      )}
      <article ref={reader} className="min-w-0 flex-1 overflow-auto p-5">
        <div className="mb-3 flex items-center gap-2">
          <button onClick={() => setTree((v) => !v)} className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200" aria-label={t("help.toggleTree")} title={t("help.toggleTree")}>
            {tree ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          <span className="text-[11px] text-slate-500">{article && label(article.category)}</span>
        </div>
        {article && (
          <>
            <div className="flex flex-wrap items-start gap-3">
              <h2 className="min-w-0 flex-1 text-xl font-semibold text-white">
                <Hl text={article.mainTitle} term={term} />
              </h2>
              <GlassButton size="sm" variant="primary" onClick={() => navigate(article.target)}>
                {t("help.openTarget")} <ArrowRight size={13} />
              </GlassButton>
            </div>
            <Shot src={article.screenshotPath} alt={article.mainTitle} />
            {article.sections.map((s) => (
              <section key={s.sectionId} data-anchor={`section-${s.sectionId}`} className="mt-4 p-1">
                <h3 className="text-sm font-semibold text-slate-100">
                  <Hl text={s.subTitle} term={term} />
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">
                  <Hl text={s.bodyText} term={term} />
                </p>
                {s.steps.length > 0 && (
                  <>
                    <p className="mt-3 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{t("help.steps")}</p>
                    <ol className="mt-1 list-decimal space-y-1 pl-5 text-xs text-slate-300">
                      {s.steps.map((x, i) => (
                        <li key={i}><Hl text={x} term={term} /></li>
                      ))}
                    </ol>
                  </>
                )}
                {s.tips.map((x, i) => (
                  <p key={i} className="mt-2 flex gap-2 rounded-lg bg-amber-300/10 px-3 py-2 text-xs text-amber-100">
                    <Lightbulb size={13} className="mt-0.5 shrink-0" /> <span><Hl text={x} term={term} /></span>
                  </p>
                ))}
                {s.screenshotPath !== article.screenshotPath && <Shot src={s.screenshotPath} alt={s.subTitle} />}
              </section>
            ))}
          </>
        )}
      </article>
    </div>
  );
}
