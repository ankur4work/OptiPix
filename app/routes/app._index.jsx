import { useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Divider,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  const navigate = useNavigate();

  return (
    <Page>
      {/* Hero */}
      <div className="pb-hero">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <BlockStack gap="200">
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "white" }}>
              Welcome to OptiPix
            </h1>
            <p style={{ fontSize: 14, opacity: 0.88, margin: 0, color: "white" }}>
              Image Optimization &amp; SEO Suite — compress images, generate AI alt text, track performance
            </p>
          </BlockStack>
          <Button
            variant="primary"
            onClick={() => navigate("/app/alttextsuggestions")}
            size="large"
          >
            Get Started
          </Button>
        </InlineStack>
      </div>

      <Layout>
        {/* 3 feature cards */}
        <Layout.Section>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>

            {/* Alt Text */}
            <div className="pb-feature-card">
              <div className="pb-feature-icon">✨</div>
              <div className="pb-step-badge" style={{ marginBottom: 10 }}>1</div>
              <p className="pb-feature-title">AI Alt Text Generator</p>
              <p className="pb-feature-desc">
                Use AI vision to write SEO-optimized alt text for every product image automatically.
              </p>
              <ul className="pb-feature-list">
                <li>OpenAI GPT-4o-mini</li>
                <li>Anthropic Claude Haiku</li>
                <li>SEO score per image</li>
                <li>Bulk apply in one click</li>
              </ul>
              <Button variant="primary" onClick={() => navigate("/app/alttextsuggestions")} fullWidth>
                Generate Alt Text
              </Button>
            </div>

            {/* Image Optimization */}
            <div className="pb-feature-card">
              <div className="pb-feature-icon">⚡</div>
              <div className="pb-step-badge" style={{ marginBottom: 10 }}>2</div>
              <p className="pb-feature-title">Image Optimizer</p>
              <p className="pb-feature-desc">
                Compress and convert product images to WebP — reduce file sizes by up to 70%.
              </p>
              <ul className="pb-feature-list">
                <li>Automatic WebP conversion</li>
                <li>Up to 70% size reduction</li>
                <li>Batch all products</li>
                <li>Replaces original images</li>
              </ul>
              <Button variant="primary" onClick={() => navigate("/app/productoptimization")} fullWidth>
                Optimize Images
              </Button>
            </div>

            {/* Page Speed */}
            <div className="pb-feature-card">
              <div className="pb-feature-icon">📊</div>
              <div className="pb-step-badge" style={{ marginBottom: 10 }}>3</div>
              <p className="pb-feature-title">Page Speed Reports</p>
              <p className="pb-feature-desc">
                Track Core Web Vitals and see before/after performance metrics for every product page.
              </p>
              <ul className="pb-feature-list">
                <li>Core Web Vitals (LCP, FID, CLS)</li>
                <li>Before / after comparison</li>
                <li>Per-product analytics</li>
                <li>Performance recommendations</li>
              </ul>
              <Button variant="primary" onClick={() => navigate("/app/pagespeedimpactreports")} fullWidth>
                View Reports
              </Button>
            </div>

          </div>
        </Layout.Section>

        {/* Quick tips */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Recommended Workflow</Text>
              <Divider />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
                <InlineStack gap="300" blockAlign="start" wrap={false}>
                  <div className="pb-step-badge">1</div>
                  <BlockStack gap="100">
                    <Text variant="bodySm" as="p" fontWeight="semibold">Generate Alt Text first</Text>
                    <Text variant="bodySm" as="p" tone="subdued">AI writes SEO descriptions before images are replaced</Text>
                  </BlockStack>
                </InlineStack>
                <InlineStack gap="300" blockAlign="start" wrap={false}>
                  <div className="pb-step-badge">2</div>
                  <BlockStack gap="100">
                    <Text variant="bodySm" as="p" fontWeight="semibold">Optimize all products</Text>
                    <Text variant="bodySm" as="p" tone="subdued">Compress images — faster store, better rankings</Text>
                  </BlockStack>
                </InlineStack>
                <InlineStack gap="300" blockAlign="start" wrap={false}>
                  <div className="pb-step-badge">3</div>
                  <BlockStack gap="100">
                    <Text variant="bodySm" as="p" fontWeight="semibold">Track improvements</Text>
                    <Text variant="bodySm" as="p" tone="subdued">Monitor Core Web Vitals and PageSpeed gains</Text>
                  </BlockStack>
                </InlineStack>
              </div>
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
