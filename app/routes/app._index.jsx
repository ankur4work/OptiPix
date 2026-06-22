import { useNavigate, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getBillingStateCached } from "../billing.server";
import { getUsage } from "../usage.server";
import { entitled } from "../plans.server";
import db from "../db.server";
import {
  Page,
  Layout,
  Card,
  Button,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  Box,
  ProgressBar,
  Divider,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let plan = null;
  try {
    plan = (await getBillingStateCached(admin, session.shop)).plan;
  } catch (e) {
    if (e instanceof Response) throw e; // let re-auth propagate
  }

  let usage = { imagesUsed: 0 };
  let autoOptimize = false;
  try {
    usage = await getUsage(session.shop);
    const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
    autoOptimize = settings?.autoOptimize ?? false;
  } catch { /* usage/settings tables not ready — defaults */ }

  return {
    plan: {
      name: plan?.name || "Free",
      tier: plan?.tier || "free",
      monthlyImages: plan?.monthlyImages ?? 100,
      altText: entitled(plan, "altText"),
      pageSpeed: entitled(plan, "pageSpeed"),
      autoOptimizeAllowed: entitled(plan, "autoOptimize"),
    },
    usage,
    autoOptimize,
  };
};

export default function Index() {
  const navigate = useNavigate();
  const { plan, usage, autoOptimize } = useLoaderData();

  const quota = plan.monthlyImages || 0;
  const used = usage?.imagesUsed || 0;
  const remaining = Math.max(0, quota - used);
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const fmt = (n) => Number(n).toLocaleString();

  const autoStatus = !plan.autoOptimizeAllowed
    ? { label: "Growth & up", tone: "attention" }
    : autoOptimize
      ? { label: "On", tone: "success" }
      : { label: "Off", tone: undefined };

  // Tool rows — a horizontal layout, distinct from the old equal 3-card grid.
  const tools = [
    {
      icon: "⚡",
      title: "Image Optimizer",
      desc: "Compress & convert product images to WebP — up to 70% smaller, originals replaced safely.",
      cta: "Open optimizer",
      onClick: () => navigate("/app/productoptimization"),
      available: true,
    },
    {
      icon: "✨",
      title: "AI Alt Text",
      desc: "Generate SEO alt text for every image with AI vision, then bulk-apply in one click.",
      cta: plan.altText ? "Generate alt text" : "Upgrade to Starter",
      onClick: () => navigate(plan.altText ? "/app/alttextsuggestions" : "/app/billing"),
      available: plan.altText,
      badge: plan.altText ? undefined : { label: "Starter & up", tone: "attention" },
    },
    {
      icon: "🔁",
      title: "Auto-optimize new products",
      desc: "Set & forget — every newly created product gets optimized automatically in the background.",
      cta: plan.autoOptimizeAllowed ? "Manage" : "Upgrade to Growth",
      onClick: () => navigate(plan.autoOptimizeAllowed ? "/app/productoptimization" : "/app/billing"),
      available: plan.autoOptimizeAllowed,
      badge: autoStatus,
    },
    {
      icon: "📊",
      title: "Page Speed Reports",
      desc: "Track Core Web Vitals (LCP, CLS, TBT) and see before/after gains per product page.",
      cta: plan.pageSpeed ? "View reports" : "Upgrade to Growth",
      onClick: () => navigate(plan.pageSpeed ? "/app/pagespeedimpactreports" : "/app/billing"),
      available: plan.pageSpeed,
      badge: plan.pageSpeed ? undefined : { label: "Growth & up", tone: "attention" },
    },
  ];

  const stats = [
    { label: "Current plan", value: plan.name },
    { label: "Images used", value: fmt(used) },
    { label: "Images left", value: fmt(remaining) },
    { label: "Auto-optimize", value: autoStatus.label },
  ];

  return (
    <Page>
      {/* Hero */}
      <div className="pb-hero">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <BlockStack gap="200">
            <h1>Welcome to PixelPerfect</h1>
            <p>Image optimization &amp; SEO suite — compress, auto-generate alt text, and rank faster.</p>
          </BlockStack>
          <Button variant="primary" size="large" onClick={() => navigate("/app/productoptimization")}>
            Optimize images
          </Button>
        </InlineStack>
      </div>

      <Layout>
        {/* Dashboard stat strip */}
        <Layout.Section>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
            {stats.map((s) => (
              <div key={s.label} className="pb-stat-card">
                <p className="pb-stat-value">{s.value}</p>
                <p className="pb-stat-label">{s.label}</p>
              </div>
            ))}
          </div>
        </Layout.Section>

        {/* Monthly usage */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingSm" as="h2">Monthly image usage</Text>
                  <Badge tone={plan.tier === "free" ? undefined : "success"}>{`${plan.name} plan`}</Badge>
                </InlineStack>
                <Button variant="plain" onClick={() => navigate("/app/billing")}>Manage plan</Button>
              </InlineStack>
              <ProgressBar progress={pct} size="small" tone={pct >= 100 ? "critical" : "primary"} />
              <Text variant="bodySm" as="p" tone="subdued">
                {`${fmt(used)} of ${fmt(quota)} images this month · ${fmt(remaining)} remaining`}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Tools — horizontal rows */}
        <Layout.Section>
          <Card padding="0">
            <BlockStack gap="0">
              {tools.map((t, i) => (
                <div key={t.title}>
                  {i > 0 && <Divider />}
                  <Box padding="400">
                    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
                      <InlineStack gap="400" blockAlign="center" wrap={false}>
                        <div className="pb-feature-icon" style={{ marginBottom: 0 }}>{t.icon}</div>
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text variant="headingSm" as="h3">{t.title}</Text>
                            {t.badge && <Badge tone={t.badge.tone}>{t.badge.label}</Badge>}
                          </InlineStack>
                          <Text variant="bodySm" as="p" tone="subdued">{t.desc}</Text>
                        </BlockStack>
                      </InlineStack>
                      <Box minWidth="160px">
                        <Button
                          variant={t.available ? "primary" : "secondary"}
                          onClick={t.onClick}
                          fullWidth
                        >
                          {t.cta}
                        </Button>
                      </Box>
                    </InlineStack>
                  </Box>
                </div>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
