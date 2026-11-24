import { useProduct } from "../store/capabilitiesStore";

/** Full product logo; the light-text or dark-text variant follows the color mode (see .brand-on-* in index.css). */
export default function ProductLogo({ className = "h-12" }: { className?: string }) {
  const p = useProduct();
  return (
    <>
      <img src={`/brand/${p.slug}-logo.svg`} alt={p.name} className={`brand-on-dark w-auto ${className}`} draggable={false} />
      <img src={`/brand/${p.slug}-logo-light.svg`} alt="" aria-hidden className={`brand-on-light w-auto ${className}`} draggable={false} />
    </>
  );
}
