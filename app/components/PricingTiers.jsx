import { useState } from "react";
import { PLAN_TIERS } from "../planCatalog";

// 4-tier pricing comparison used by both the standalone pricing page and the
// in-app pricing wall. Presentational only: `onSubscribe()` is invoked when any
// "Choose plan" button is clicked (it routes the merchant to Shopify's hosted
// managed-pricing page, where they pick the actual plan). `isLoading` disables
// the buttons while that redirect is in flight.
export default function PricingTiers({ onSubscribe, isLoading }) {
  const [cycle, setCycle] = useState("monthly");
  const yearly = cycle === "yearly";

  return (
    <div style={s.page}>
      <p style={s.appLabel}>OPTIPIX</p>
      <h1 style={s.heading}>Pricing that scales with you.</h1>
      <p style={s.subheading}>
        Optimize images, boost speed, and rank higher — pick the plan that fits your catalog.
      </p>

      <div style={s.toggleWrap}>
        <div style={s.toggle}>
          <button
            type="button"
            onClick={() => setCycle("monthly")}
            style={!yearly ? s.toggleBtnActive : s.toggleBtn}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setCycle("yearly")}
            style={yearly ? s.toggleBtnActive : s.toggleBtn}
          >
            Yearly · 2 mo free
          </button>
        </div>
      </div>

      <div style={s.grid}>
        {PLAN_TIERS.map((tier) => {
          const price = yearly ? tier.priceAnnual : tier.price;
          const unit = price === 0 ? "" : yearly ? "/ yr" : "/ mo";
          return (
            <div key={tier.name} style={tier.popular ? s.cardPopular : s.card}>
              {tier.popular && <div style={s.popularBadge}>MOST POPULAR</div>}
              <p style={s.tierName}>{tier.name}</p>
              <p style={s.tierTagline}>{tier.tagline}</p>
              <div style={s.priceRow}>
                <span style={s.priceCurrency}>$</span>
                <span style={s.priceAmount}>{price}</span>
                {unit && <span style={s.priceUnit}>&nbsp;{unit}</span>}
              </div>
              <button
                type="button"
                onClick={onSubscribe}
                disabled={isLoading}
                style={{
                  ...(tier.popular ? s.ctaPrimary : s.ctaSecondary),
                  opacity: isLoading ? 0.7 : 1,
                  cursor: isLoading ? "not-allowed" : "pointer",
                }}
              >
                {isLoading ? "Redirecting…" : price === 0 ? "Start free" : "Choose plan"}
              </button>
              <div style={s.featureList}>
                {tier.features.map((f, i) => (
                  <div key={i} style={s.featureRow}>
                    <span style={s.check}>✓</span>
                    <span style={s.featureText}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <p style={s.disclaimer}>Secure billing through Shopify · Cancel anytime</p>
    </div>
  );
}

const s = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #FFF7F4 0%, #FFE8DF 100%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "48px 24px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  appLabel: {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.22em",
    color: "#F4476B", margin: "0 0 16px 0", textTransform: "uppercase",
  },
  heading: {
    fontSize: 40, fontWeight: 800, color: "#111827",
    margin: "0 0 10px 0", textAlign: "center", letterSpacing: "-0.5px", lineHeight: 1.1,
  },
  subheading: {
    fontSize: 15, color: "#6B7280", margin: "0 0 28px 0",
    textAlign: "center", maxWidth: 560,
  },
  toggleWrap: { marginBottom: 32 },
  toggle: { display: "flex", background: "#FCDCD0", borderRadius: 999, padding: 4 },
  toggleBtn: {
    border: "none", background: "transparent", color: "#9A5C4E",
    fontSize: 13, fontWeight: 600, padding: "8px 18px", borderRadius: 999,
    cursor: "pointer", whiteSpace: "nowrap",
  },
  toggleBtnActive: {
    border: "none", background: "linear-gradient(135deg, #FF7A45 0%, #F4476B 100%)", color: "#FFFFFF",
    fontSize: 13, fontWeight: 700, padding: "8px 18px", borderRadius: 999,
    cursor: "pointer", whiteSpace: "nowrap",
    boxShadow: "0 4px 12px rgba(244,71,107,0.35)",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 20,
    width: "100%",
    maxWidth: 1080,
    alignItems: "start",
  },
  card: {
    position: "relative",
    background: "#FFFFFF",
    borderRadius: 16,
    padding: "28px 24px",
    boxShadow: "0 8px 30px rgba(0,0,0,0.06)",
    border: "1px solid #EEECE5",
  },
  cardPopular: {
    position: "relative",
    background: "#FFFFFF",
    borderRadius: 18,
    padding: "28px 24px",
    boxShadow: "0 20px 50px rgba(244,71,107,0.28)",
    border: "2px solid #F4476B",
    transform: "translateY(-8px)",
  },
  popularBadge: {
    position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)",
    background: "linear-gradient(135deg, #FF7A45 0%, #F4476B 100%)", color: "#FFFFFF",
    fontSize: 10, fontWeight: 800,
    letterSpacing: "0.12em", padding: "5px 12px", borderRadius: 999, whiteSpace: "nowrap",
    boxShadow: "0 4px 12px rgba(244,71,107,0.4)",
  },
  tierName: { fontSize: 18, fontWeight: 800, color: "#1A1426", margin: "0 0 2px 0" },
  tierTagline: { fontSize: 12, color: "#B0857A", margin: "0 0 16px 0" },
  priceRow: { display: "flex", alignItems: "flex-start", marginBottom: 18 },
  priceCurrency: { fontSize: 20, fontWeight: 700, color: "#F4476B", marginTop: 6 },
  priceAmount: { fontSize: 44, fontWeight: 800, color: "#1A1426", lineHeight: 1 },
  priceUnit: { fontSize: 14, color: "#B0857A", marginTop: 8, fontWeight: 400 },
  ctaPrimary: {
    width: "100%", padding: "12px", background: "linear-gradient(135deg, #FF7A45 0%, #F4476B 100%)", color: "white",
    border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, marginBottom: 20,
    boxShadow: "0 6px 16px rgba(244,71,107,0.35)",
  },
  ctaSecondary: {
    width: "100%", padding: "12px", background: "#FFF1EC", color: "#D62F57",
    border: "1px solid #FAD2C5", borderRadius: 10, fontSize: 14, fontWeight: 700, marginBottom: 20,
  },
  featureList: { display: "flex", flexDirection: "column", gap: 10 },
  featureRow: { display: "flex", alignItems: "flex-start", gap: 8 },
  check: { color: "#F4476B", fontWeight: 800, fontSize: 13, lineHeight: "18px", flexShrink: 0 },
  featureText: { fontSize: 13, color: "#374151", lineHeight: "18px" },
  disclaimer: { textAlign: "center", fontSize: 12, color: "#B0857A", marginTop: 32 },
};
