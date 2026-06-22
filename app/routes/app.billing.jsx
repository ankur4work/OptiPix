import { useLoaderData, useSubmit, useNavigation, useActionData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getBillingState,
  managedPricingUrl,
  appBridgeRedirect,
  cancelSubscription,
  BILLING_CONFIG,
} from "../billing.server";
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Badge,
  List,
  Divider,
  Banner,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  let hasActivePlan = false;
  try {
    const state = await getBillingState(admin);
    hasActivePlan = state.hasActivePlan;
  } catch (e) {
    if (e instanceof Response) throw e;
    hasActivePlan = false;
  }

  return {
    hasActivePlan,
    plan: BILLING_CONFIG.planName,
    amount: BILLING_CONFIG.amount,
    amountYearly: BILLING_CONFIG.amountYearly,
    yearlyEnabled: BILLING_CONFIG.yearlyEnabled,
    trialDays: BILLING_CONFIG.trialDays,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  const state = await getBillingState(admin);
  const pricingUrl = managedPricingUrl(session.shop, state.appHandle);

  // Subscribe / change plan → Shopify's hosted managed-pricing page.
  if (actionType === "subscribe") {
    throw appBridgeRedirect(pricingUrl);
  }

  // Cancel: try the in-app cancel mutation first. If managed pricing blocks it,
  // fall back to the hosted page where the merchant can cancel manually.
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
  const { hasActivePlan, plan, amount, amountYearly, yearlyEnabled, trialDays } = useLoaderData();
  const monthsFree = amount > 0 ? Math.round((amount * 12 - amountYearly) / amount) : 0;
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isBusy = navigation.state !== "idle";

  const features = [
    "AI Alt Text Suggestions (OpenAI + Claude)",
    "Product Image Optimization",
    "Automatic WebP Conversion",
    "Bulk Processing",
    "Page Speed Impact Analysis",
    "Performance Score Tracking",
    "Core Web Vitals (LCP, FID, CLS)",
    "Before/After Metrics",
  ];

  const handleSubscribe = () => {
    const formData = new FormData();
    formData.append("actionType", "subscribe");
    submit(formData, { method: "post" });
  };

  const handleCancel = () => {
    const formData = new FormData();
    formData.append("actionType", "cancel");
    submit(formData, { method: "post" });
  };

  return (
    <Page
      title="OptiPix — Billing"
      subtitle="Manage your OptiPix subscription"
    >
      <Layout>
        {actionData?.cancelled && !hasActivePlan && (
          <Layout.Section>
            <Banner title="Subscription cancelled" tone="info">
              Your plan has been cancelled. Subscribe again any time to unlock features.
            </Banner>
          </Layout.Section>
        )}

        {hasActivePlan && (
          <Layout.Section>
            <Banner title="Active subscription" tone="success">
              You are on the {plan} plan. All features are unlocked.
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="200">
                  <InlineStack gap="300" blockAlign="center">
                    <Text variant="headingXl" as="h2">{plan}</Text>
                    {hasActivePlan && <Badge tone="success">Active</Badge>}
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">Everything you need to optimize your store</Text>
                </BlockStack>
                <BlockStack gap="100" inlineAlign="end">
                  <Text variant="heading3xl" as="p">${amount}</Text>
                  <Text variant="bodySm" as="p" tone="subdued">/ month</Text>
                  {yearlyEnabled && (
                    <Text variant="bodySm" as="p" tone="subdued">
                      or ${amountYearly}/year{monthsFree > 0 ? ` (${monthsFree} months free)` : ""}
                    </Text>
                  )}
                </BlockStack>
              </InlineStack>

              <Divider />

              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">Features included</Text>
                <List type="bullet">
                  {features.map((feature) => (
                    <List.Item key={feature}>{feature}</List.Item>
                  ))}
                </List>
              </BlockStack>

              <Divider />

              <InlineStack align="end" gap="300">
                {hasActivePlan ? (
                  <Button tone="critical" variant="plain" loading={isBusy} onClick={handleCancel}>
                    Cancel subscription
                  </Button>
                ) : (
                  <Button variant="primary" size="large" loading={isBusy} onClick={handleSubscribe}>
                    {trialDays > 0
                      ? `Start ${trialDays}-day free trial — then $${amount}/month`
                      : `Subscribe — $${amount}/month`}
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Box paddingBlockStart="400">
            <Text variant="bodySm" as="p" tone="subdued">
              {yearlyEnabled
                ? `Choose monthly ($${amount}/30 days) or yearly ($${amountYearly}/year${monthsFree > 0 ? `, ${monthsFree} months free` : ""}) billing through Shopify. `
                : "Billed every 30 days through Shopify. "}
              Subscribe, change, or cancel your plan from this page — all changes are handled
              securely on Shopify's billing page and reflected here.
            </Text>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
