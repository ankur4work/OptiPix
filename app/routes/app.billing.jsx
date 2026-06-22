import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getBillingState,
  managedPricingUrl,
  appBridgeRedirect,
  cancelSubscription,
} from "../billing.server";
import { getUsage } from "../usage.server";
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Divider,
  Banner,
  ProgressBar,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";

// Human labels for the entitlement flags, shown as the current plan's inclusions.
const FEATURE_LABELS = {
  optimize: "Image optimization & WebP conversion",
  altText: "AI alt text",
  filenameSeo: "SEO filenames",
  resize: "Resize & crop",
  scheduling: "Scheduled runs",
  watermark: "Watermarking",
  heic: "HEIC support",
  autoOptimize: "Auto-optimize new products",
  pageSpeed: "Page Speed reports",
  bulkExport: "Bulk image export",
  priority: "Priority processing",
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let state = { hasActivePlan: false, plan: null };
  try {
    state = await getBillingState(admin, session.shop);
  } catch (e) {
    if (e instanceof Response) throw e;
  }

  let usage = { imagesUsed: 0 };
  try { usage = await getUsage(session.shop); } catch { /* table not ready */ }

  const plan = state.plan || { name: "Free", tier: "free", monthlyImages: 100, features: {} };
  const included = Object.keys(FEATURE_LABELS).filter((k) => plan.features?.[k]);

  return {
    hasActivePlan: state.hasActivePlan,
    planName: plan.name,
    tier: plan.tier,
    monthlyImages: plan.monthlyImages,
    included,
    imagesUsed: usage.imagesUsed || 0,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  const state = await getBillingState(admin);
  const pricingUrl = managedPricingUrl(session.shop, state.appHandle);

  // Subscribe / change / upgrade → Shopify's hosted managed-pricing page (where
  // all 4 plans live and the merchant picks/switches).
  if (actionType === "subscribe" || actionType === "change") {
    throw appBridgeRedirect(pricingUrl);
  }

  // Cancel: try the in-app cancel mutation first; if managed pricing blocks it,
  // fall back to the hosted page to cancel manually.
  if (actionType === "cancel") {
    const sub = state.activeSubscription;
    if (!sub) return { cancelled: true };
    try {
      await cancelSubscription(admin, sub.id);
      return { cancelled: true };
    } catch (e) {
      console.error("[BILLING] in-app cancel failed, redirecting:", e?.message);
      throw appBridgeRedirect(pricingUrl);
    }
  }

  return null;
};

export default function BillingPage() {
  const { hasActivePlan, planName, tier, monthlyImages, included, imagesUsed } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isBusy = navigation.state !== "idle";

  const post = (actionType) => {
    const fd = new FormData();
    fd.append("actionType", actionType);
    submit(fd, { method: "post" });
  };

  const quota = monthlyImages || 0;
  const used = imagesUsed || 0;
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const fmt = (n) => Number(n).toLocaleString();

  return (
    <Page title="PixelPerfect — Billing" subtitle="Manage your plan">
      <Layout>
        {actionData?.cancelled && !hasActivePlan && (
          <Layout.Section>
            <Banner title="Subscription cancelled" tone="info">
              Your plan has been cancelled. Choose a plan any time to unlock more.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="200">
                  <InlineStack gap="300" blockAlign="center">
                    <Text variant="headingXl" as="h2">{planName}</Text>
                    {hasActivePlan
                      ? <Badge tone="success">Active</Badge>
                      : <Badge>Current</Badge>}
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {`Up to ${fmt(quota)} optimized images per month`}
                  </Text>
                </BlockStack>
                <InlineStack gap="300">
                  <Button variant="primary" loading={isBusy} onClick={() => post("change")}>
                    {hasActivePlan ? "Change plan" : "Choose a plan"}
                  </Button>
                  {hasActivePlan && (
                    <Button tone="critical" variant="plain" loading={isBusy} onClick={() => post("cancel")}>
                      Cancel
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>

              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodySm" as="p" tone="subdued">Images this month</Text>
                  <Text variant="bodySm" as="p" tone={pct >= 100 ? "critical" : "subdued"}>
                    {`${fmt(used)} / ${fmt(quota)}`}
                  </Text>
                </InlineStack>
                <ProgressBar progress={pct} size="small" tone={pct >= 100 ? "critical" : "primary"} />
              </BlockStack>

              <Divider />

              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">Included in your plan</Text>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                  {included.map((k) => (
                    <InlineStack key={k} gap="200" blockAlign="center">
                      <span style={{ color: "#F4476B", fontWeight: 800 }}>✓</span>
                      <Text variant="bodySm" as="span">{FEATURE_LABELS[k]}</Text>
                    </InlineStack>
                  ))}
                </div>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Text variant="bodySm" as="p" tone="subdued">
            Plans and prices are managed securely on Shopify's billing page. Use “Change plan”
            to upgrade, downgrade, or switch between monthly and yearly — changes are reflected
            here automatically.
          </Text>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
