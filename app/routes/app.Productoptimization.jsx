import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLoaderData, useFetcher, useRevalidator } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { getUsage, getRemaining } from '../usage.server';
import { entitled } from '../plans.server';
import db from '../db.server';
import { mapLimit, headSizeMB, optimizeBatch } from '../optimize.server';
import {
  Page,
  Layout,
  Card,
  Button,
  Badge,
  Checkbox,
  Text,
  Box,
  InlineStack,
  BlockStack,
  Thumbnail,
  Divider,
  Banner,
  ProgressBar,
  Select,
  EmptyState
} from '@shopify/polaris';

/* -------------------------------------------------------------------------- */
/*  Product fetching (loader only)                                            */
/* -------------------------------------------------------------------------- */

async function fetchAllProducts(admin, cursor = null) {
  const query = `#graphql
    query GetProductsWithImages($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            status
            featuredImage { id url altText width height }
            images(first: 250) {
              edges { node { id url altText width height } }
            }
            metafields(first: 250, namespace: "image_optimization") {
              edges { node { key value } }
            }
          }
        }
      }
    }
  `;
  const response = await admin.graphql(query, { variables: { cursor } });
  return await response.json();
}

async function getAllProducts(admin) {
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  while (hasNextPage) {
    const data = await fetchAllProducts(admin, cursor);
    const products = data.data.products.edges.map(edge => edge.node);
    allProducts = [...allProducts, ...products];
    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }
  return allProducts;
}

// Parse the optimization_summary metafield (totals written by the action).
function parseSummary(product) {
  const mf = product.metafields.edges.find(e => e.node.key === 'optimization_summary');
  if (!mf) return null;
  try {
    return JSON.parse(mf.node.value);
  } catch {
    return null;
  }
}

function countProcessed(product) {
  return product.metafields.edges.filter(e => e.node.key.startsWith('image_')).length;
}

/* -------------------------------------------------------------------------- */
/*  Loader                                                                    */
/* -------------------------------------------------------------------------- */

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  const sortBy = url.searchParams.get('sortBy') || 'score_asc';

  // Plan, usage and per-shop settings drive the quota meter + auto-optimize UI.
  let plan = null;
  try {
    const state = await getBillingStateCached(admin, session.shop);
    plan = state.plan;
  } catch { /* fall through to Free defaults below */ }
  let usage = { period: '', imagesUsed: 0 };
  let autoOptimize = false;
  try {
    usage = await getUsage(session.shop);
    const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
    autoOptimize = settings?.autoOptimize ?? false;
  } catch { /* usage/settings tables not ready yet — default to zero/off */ }
  const planInfo = {
    tier: plan?.tier || 'free',
    name: plan?.name || 'Free',
    monthlyImages: plan?.monthlyImages ?? 100,
    autoOptimizeAllowed: entitled(plan, 'autoOptimize'),
  };

  try {
    const products = await getAllProducts(admin);

    // Build a flat list of images we need to measure (only for products that
    // have never been optimized — optimized products carry totals in their
    // summary metafield). Measured with bounded concurrency + IPv4 so the page
    // loads in a few seconds instead of stalling on per-image connect timeouts.
    const measureTasks = [];
    for (const product of products) {
      if (parseSummary(product)) continue;
      for (const edge of product.images.edges) {
        measureTasks.push({ productId: product.id, url: edge.node.url });
      }
    }
    const measuredSizes = await mapLimit(measureTasks, 24, t => headSizeMB(t.url));
    const measuredByProduct = {};
    measureTasks.forEach((t, i) => {
      measuredByProduct[t.productId] = (measuredByProduct[t.productId] || 0) + (measuredSizes[i] || 0);
    });

    const processedProducts = products.map((product) => {
      const images = product.images.edges.map(e => e.node);
      const imageCount = images.length;
      const imagesWithAlt = images.filter(img => img.altText && img.altText.length > 10).length;

      const summary = parseSummary(product);
      let processed = summary ? (summary.optimizedImages || 0) : countProcessed(product);
      processed = Math.min(processed, imageCount);

      let totalOriginalSize;
      let totalOptimizedSize;
      if (summary) {
        totalOriginalSize = summary.totalOriginalSizeMB || 0;
        totalOptimizedSize = summary.totalOptimizedSizeMB || 0;
      } else {
        totalOriginalSize = measuredByProduct[product.id] || 0;
        totalOptimizedSize = totalOriginalSize; // nothing saved yet
      }

      const score = imageCount > 0 ? Math.round((processed / imageCount) * 100) : 0;
      const sizeSavedMB = Math.max(0, totalOriginalSize - totalOptimizedSize);
      const compressionRate = totalOriginalSize > 0
        ? Math.max(0, Math.round((sizeSavedMB / totalOriginalSize) * 100))
        : 0;

      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        imageCount,
        imagesWithAlt,
        optimizedImages: processed,
        score,
        totalOriginalSizeMB: totalOriginalSize,
        totalOptimizedSizeMB: totalOptimizedSize,
        sizeSavedMB,
        compressionRate,
        featuredImageUrl: product.featuredImage?.url || images[0]?.url,
        needsOptimization: score < 100,
      };
    });

    // Return ALL products; filtering/sorting happens instantly on the client
    // from this list, so changing a filter never re-runs this (heavy) loader.
    return {
      products: processedProducts,
      filter,
      sortBy,
      plan: planInfo,
      usage,
      autoOptimize,
      stats: {
        total: processedProducts.length,
        needsOptimization: processedProducts.filter(p => p.needsOptimization).length,
        optimized: processedProducts.filter(p => !p.needsOptimization).length,
        totalImages: processedProducts.reduce((s, p) => s + p.imageCount, 0),
        totalSizeMB: processedProducts.reduce((s, p) => s + p.totalOriginalSizeMB, 0),
        potentialSavingsMB: processedProducts.reduce((s, p) => s + p.sizeSavedMB, 0),
      },
      error: null,
    };
  } catch (error) {
    console.error('Error loading products:', error);
    return {
      products: [],
      filter,
      sortBy,
      plan: planInfo,
      usage,
      autoOptimize,
      stats: { total: 0, needsOptimization: 0, optimized: 0, totalImages: 0, totalSizeMB: 0, potentialSavingsMB: 0 },
      error: 'Failed to load products',
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Action — toggles auto-optimize, or processes ONE optimization batch       */
/* -------------------------------------------------------------------------- */

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'setAutoOptimize') {
    const enabled = formData.get('enabled') === 'true';
    // Enabling is gated by plan entitlement; disabling is always allowed.
    if (enabled) {
      try {
        const { plan } = await getBillingStateCached(admin, session.shop);
        if (!entitled(plan, 'autoOptimize')) {
          return { success: false, settingUpdated: true, error: 'Upgrade to Growth to auto-optimize new products.' };
        }
      } catch { /* if billing check fails, fall through and block enabling */
        return { success: false, settingUpdated: true, error: 'Could not verify your plan. Try again.' };
      }
    }
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, autoOptimize: enabled },
      update: { autoOptimize: enabled },
    });
    return { success: true, settingUpdated: true, autoOptimize: enabled };
  }

  if (actionType === 'optimizeProduct') {
    const productId = formData.get('productId');
    try {
      const { plan } = await getBillingStateCached(admin, session.shop);
      const remainingQuota = await getRemaining(session.shop, plan);
      return await optimizeBatch(admin, productId, { shop: session.shop, remainingQuota });
    } catch (error) {
      const msg = error?.graphQLErrors?.[0]?.message || error?.message || 'unknown error';
      console.error('[OPTIMIZE] product failed:', msg);
      return { success: false, productId, error: 'Failed to optimize product: ' + msg };
    }
  }

  return { success: false, error: 'Invalid action' };
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

export default function ProductOptimization() {
  const {
    products, filter: initialFilter, sortBy: initialSortBy, stats, error: loadError,
    plan, usage, autoOptimize: initialAutoOptimize,
  } = useLoaderData();
  const fetcher = useFetcher();
  const settingsFetcher = useFetcher();
  const revalidator = useRevalidator();

  const [filter, setFilter] = useState(initialFilter);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [error, setError] = useState(loadError);
  const [successMessage, setSuccessMessage] = useState(null);
  const [autoOptimize, setAutoOptimize] = useState(initialAutoOptimize);

  // Live per-product progress, keyed by product id, updated after every batch.
  const [liveProgress, setLiveProgress] = useState({});
  const [activeId, setActiveId] = useState(null);
  const queueRef = useRef([]);
  const activeRef = useRef(null);

  // Track images optimized this session so the usage meter moves without a reload.
  const [sessionImages, setSessionImages] = useState(0);
  const lastOptimizedRef = useRef({}); // productId -> optimized count last seen

  const startNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) {
      activeRef.current = null;
      setActiveId(null);
      // Quietly re-run the loader in place (no full-page reload). The live
      // numbers in liveProgress remain authoritative for display, so stale
      // read-after-write metafield lag can't flip a finished product back to
      // "needs optimization".
      revalidator.revalidate();
      return;
    }
    activeRef.current = next;
    setActiveId(next);
    fetcher.submit({ actionType: 'optimizeProduct', productId: next }, { method: 'post' });
  }, [fetcher, revalidator]);

  // Drive the batch loop: each completed batch either continues the same
  // product or advances to the next queued product.
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    const data = fetcher.data;
    if (!data.productId || data.productId !== activeRef.current) return;

    if (data.success === false) {
      setError(data.error || 'Optimization failed');
      startNext();
      return;
    }

    setLiveProgress(prev => ({ ...prev, [data.productId]: data }));

    // Increment the session usage meter by the newly-optimized image delta.
    const prevSeen = lastOptimizedRef.current[data.productId] || 0;
    const delta = Math.max(0, (data.optimized || 0) - prevSeen);
    if (delta > 0) {
      lastOptimizedRef.current[data.productId] = data.optimized;
      setSessionImages(s => s + delta);
    }

    // Monthly quota hit — stop the whole queue and prompt to upgrade.
    if (data.quotaExceeded) {
      setError('Monthly image quota reached. Upgrade your plan to optimize more images this month.');
      queueRef.current = [];
      startNext();
      return;
    }

    if (data.done) {
      setSuccessMessage(data.message);
      setTimeout(() => setSuccessMessage(null), 4000);
      startNext();
    } else if (!data.advanced) {
      // A whole batch failed (e.g. unreachable images) — stop to avoid looping.
      setError(`Some images for "${data.title}" couldn't be processed (${data.remaining} remaining). Try again.`);
      startNext();
    } else {
      fetcher.submit({ actionType: 'optimizeProduct', productId: data.productId }, { method: 'post' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // Reflect the saved auto-optimize setting (or surface a gating error).
  useEffect(() => {
    if (settingsFetcher.state !== 'idle' || !settingsFetcher.data) return;
    const d = settingsFetcher.data;
    if (!d.settingUpdated) return;
    if (d.success) {
      setAutoOptimize(d.autoOptimize);
    } else {
      setError(d.error || 'Could not update setting.');
      setAutoOptimize(false); // revert optimistic flip
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsFetcher.state, settingsFetcher.data]);

  const beginQueue = useCallback((ids) => {
    if (!ids.length || activeRef.current) return;
    setError(null);
    queueRef.current = [...ids];
    startNext();
  }, [startNext]);

  // Filter/sort are pure client-side transforms of the already-loaded product
  // list — no server roundtrip, so the list updates instantly.
  const handleFilterChange = useCallback((value) => setFilter(value), []);
  const handleSortChange = useCallback((value) => setSortBy(value), []);

  const handleToggleAutoOptimize = useCallback((checked) => {
    setAutoOptimize(checked); // optimistic
    setError(null);
    settingsFetcher.submit(
      { actionType: 'setAutoOptimize', enabled: String(checked) },
      { method: 'post' }
    );
  }, [settingsFetcher]);

  const displayedProducts = useMemo(() => {
    let list = products;
    if (filter === 'needs_optimization') list = list.filter(p => p.needsOptimization);
    else if (filter === 'optimized') list = list.filter(p => !p.needsOptimization);
    else if (filter === 'no_alt_text') list = list.filter(p => p.imagesWithAlt === 0);

    // Sort a copy so we never mutate loader data (which would corrupt the next
    // filter pass). Score reflects live progress, so re-sorts stay correct.
    const sorted = [...list];
    if (sortBy === 'score_asc') sorted.sort((a, b) => a.score - b.score);
    else if (sortBy === 'score_desc') sorted.sort((a, b) => b.score - a.score);
    else if (sortBy === 'size_desc') sorted.sort((a, b) => b.totalOriginalSizeMB - a.totalOriginalSizeMB);
    else if (sortBy === 'images_desc') sorted.sort((a, b) => b.imageCount - a.imageCount);
    return sorted;
  }, [products, filter, sortBy]);

  const handleSelectProduct = useCallback((id) => {
    setSelectedProducts(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedProducts(selectedProducts.length === displayedProducts.length ? [] : displayedProducts.map(p => p.id));
  }, [selectedProducts.length, displayedProducts]);

  const handleOptimizeProduct = useCallback((id) => beginQueue([id]), [beginQueue]);
  const handleOptimizeSelected = useCallback(() => {
    beginQueue(selectedProducts);
    setSelectedProducts([]);
  }, [beginQueue, selectedProducts]);

  const isBusy = activeId !== null;

  // Usage meter: loader baseline + images optimized live this session.
  const quota = plan?.monthlyImages ?? 100;
  const usedImages = (usage?.imagesUsed ?? 0) + sessionImages;
  const usagePct = quota > 0 ? Math.min(100, Math.round((usedImages / quota) * 100)) : 0;
  const quotaReached = usedImages >= quota;

  const getScoreBadge = (score) => {
    if (score >= 80) return <Badge tone="success">{`${score}%`}</Badge>;
    if (score >= 60) return <Badge tone="attention">{`${score}%`}</Badge>;
    return <Badge tone="critical">{`${score}%`}</Badge>;
  };

  const formatBytes = (mb) => {
    const v = mb || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(1)} GB`;
    if (v >= 1) return `${v.toFixed(1)} MB`;
    if (v > 0) return `${Math.max(1, Math.round(v * 1024))} KB`;
    return `0 KB`;
  };

  const filterOptions = [
    { label: 'All Products', value: 'all' },
    { label: 'Needs Optimization', value: 'needs_optimization' },
    { label: 'Optimized', value: 'optimized' },
    { label: 'No Alt Text', value: 'no_alt_text' },
  ];
  const sortOptions = [
    { label: 'Score: Low to High', value: 'score_asc' },
    { label: 'Score: High to Low', value: 'score_desc' },
    { label: 'Size: Largest First', value: 'size_desc' },
    { label: 'Most Images First', value: 'images_desc' },
  ];

  // Merge loader values with any live progress for a product.
  const view = (product) => {
    const lp = liveProgress[product.id];
    if (!lp) return product;
    return {
      ...product,
      score: lp.score,
      optimizedImages: lp.optimized,
      totalOriginalSizeMB: lp.originalSizeMB || product.totalOriginalSizeMB,
      sizeSavedMB: lp.sizeSavedMB,
      compressionRate: lp.compressionRate,
      needsOptimization: lp.score < 100,
    };
  };

  const liveSavings = stats.potentialSavingsMB
    + Object.entries(liveProgress).reduce((sum, [id, lp]) => {
        const base = products.find(p => p.id === id)?.sizeSavedMB || 0;
        return sum + Math.max(0, (lp.sizeSavedMB || 0) - base);
      }, 0);

  return (
    <Page
      title="OptiPix — Image Optimizer"
      subtitle="Compress and replace product images with real optimization and automatic WebP conversion"
    >
      <Layout>
        <Layout.Section>
          <div className="pb-page-header">
            <span className="pb-page-header-icon">⚡</span>
            <div>
              <p className="pb-page-header-title">Image Optimizer</p>
              <p className="pb-page-header-sub">WebP conversion &amp; smart compression — up to 70% smaller</p>
            </div>
          </div>
        </Layout.Section>

        {error && (
          <Layout.Section>
            <Banner title="Error" tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        )}
        {successMessage && (
          <Layout.Section>
            <Banner title="Success" tone="success" onDismiss={() => setSuccessMessage(null)}>{successMessage}</Banner>
          </Layout.Section>
        )}

        {/* Plan usage meter */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingSm" as="h3">Monthly usage</Text>
                  <Badge tone={plan?.tier === 'free' ? undefined : 'success'}>{`${plan?.name || 'Free'} plan`}</Badge>
                </InlineStack>
                <Text variant="bodyMd" as="p" tone={quotaReached ? 'critical' : 'subdued'}>
                  {`${usedImages.toLocaleString()} / ${quota.toLocaleString()} images`}
                </Text>
              </InlineStack>
              <ProgressBar progress={usagePct} size="small" tone={quotaReached ? 'critical' : 'primary'} />
              {quotaReached && (
                <Text variant="bodySm" as="p" tone="critical">
                  You've used your monthly image quota. Upgrade your plan to optimize more images.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Auto-optimize new products (Growth+) */}
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingSm" as="h3">Auto-optimize new products</Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    Automatically optimize images on every newly created product — set it and forget it.
                  </Text>
                </BlockStack>
                {plan?.autoOptimizeAllowed
                  ? <Badge tone={autoOptimize ? 'success' : undefined}>{autoOptimize ? 'On' : 'Off'}</Badge>
                  : <Badge tone="attention">Growth & up</Badge>}
              </InlineStack>
              {plan?.autoOptimizeAllowed ? (
                <Checkbox
                  label="Automatically optimize images on newly created products"
                  checked={autoOptimize}
                  onChange={handleToggleAutoOptimize}
                  disabled={settingsFetcher.state !== 'idle'}
                />
              ) : (
                <Banner tone="info">
                  Background auto-optimization is available on the Growth plan and above.
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="400" wrap={false}>
            <Box width="25%">
              <Card><BlockStack gap="200">
                <Text variant="bodyMd" as="p" tone="subdued">Total Products</Text>
                <Text variant="heading2xl" as="h2">{stats.total}</Text>
              </BlockStack></Card>
            </Box>
            <Box width="25%">
              <Card><BlockStack gap="200">
                <Text variant="bodyMd" as="p" tone="subdued">Needs Optimization</Text>
                <Text variant="heading2xl" as="h2" tone="critical">{stats.needsOptimization}</Text>
              </BlockStack></Card>
            </Box>
            <Box width="25%">
              <Card><BlockStack gap="200">
                <Text variant="bodyMd" as="p" tone="subdued">Total Images</Text>
                <Text variant="heading2xl" as="h2">{stats.totalImages}</Text>
              </BlockStack></Card>
            </Box>
            <Box width="25%">
              <Card><BlockStack gap="200">
                <Text variant="bodyMd" as="p" tone="subdued">Actual Savings</Text>
                <Text variant="heading2xl" as="h2" tone="success">{formatBytes(liveSavings)}</Text>
              </BlockStack></Card>
            </Box>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="300">
                  <Box width="200px">
                    <Select label="Filter" options={filterOptions} value={filter} onChange={handleFilterChange} disabled={isBusy} />
                  </Box>
                  <Box width="200px">
                    <Select label="Sort by" options={sortOptions} value={sortBy} onChange={handleSortChange} disabled={isBusy} />
                  </Box>
                </InlineStack>
                {selectedProducts.length > 0 && (
                  <Button variant="primary" onClick={handleOptimizeSelected} loading={isBusy} disabled={isBusy || quotaReached}>
                    {`Optimize Selected (${selectedProducts.length})`}
                  </Button>
                )}
              </InlineStack>
              <Divider />
              <Checkbox
                label={`Select All (${displayedProducts.length} products)`}
                checked={selectedProducts.length === displayedProducts.length && displayedProducts.length > 0}
                onChange={handleSelectAll}
                disabled={isBusy}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {displayedProducts.length === 0 ? (
                <EmptyState heading="No products found" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                  <p>Try adjusting your filters to see products.</p>
                </EmptyState>
              ) : (
                displayedProducts.map((raw) => {
                  const product = view(raw);
                  const isActive = activeId === product.id;
                  return (
                    <Card key={product.id} background={selectedProducts.includes(product.id) ? 'bg-surface-selected' : undefined}>
                      <InlineStack gap="400" blockAlign="start">
                        <Checkbox checked={selectedProducts.includes(product.id)} onChange={() => handleSelectProduct(product.id)} disabled={isBusy} />
                        {product.featuredImageUrl && (
                          <Thumbnail source={product.featuredImageUrl} alt={product.title} size="large" />
                        )}
                        <Box width="100%">
                          <BlockStack gap="400">
                            <InlineStack align="space-between" blockAlign="center">
                              <BlockStack gap="200">
                                <Text variant="headingMd" as="h3">{product.title}</Text>
                                <InlineStack gap="200">
                                  <Badge>{product.status}</Badge>
                                  <Badge tone="info">{`${product.imageCount} images`}</Badge>
                                  {isActive && <Badge tone="attention">Optimizing…</Badge>}
                                </InlineStack>
                              </BlockStack>
                              {getScoreBadge(product.score)}
                            </InlineStack>

                            <Divider />

                            <InlineStack gap="800" wrap={true}>
                              <BlockStack gap="200">
                                <Text variant="bodySm" as="p" tone="subdued">Images with Alt Text</Text>
                                <Text variant="bodyMd" as="p" fontWeight="semibold">{`${product.imagesWithAlt} / ${product.imageCount}`}</Text>
                              </BlockStack>
                              <BlockStack gap="200">
                                <Text variant="bodySm" as="p" tone="subdued">Optimized Images</Text>
                                <Text variant="bodyMd" as="p" fontWeight="semibold">{`${product.optimizedImages} / ${product.imageCount}`}</Text>
                              </BlockStack>
                              <BlockStack gap="200">
                                <Text variant="bodySm" as="p" tone="subdued">Original Size</Text>
                                <Text variant="bodyMd" as="p" fontWeight="semibold">{formatBytes(product.totalOriginalSizeMB)}</Text>
                              </BlockStack>
                              <BlockStack gap="200">
                                <Text variant="bodySm" as="p" tone="subdued">Size Saved</Text>
                                <Text variant="bodyMd" as="p" fontWeight="semibold" tone="success">{`${formatBytes(product.sizeSavedMB)} (${product.compressionRate}%)`}</Text>
                              </BlockStack>
                            </InlineStack>

                            <BlockStack gap="200">
                              <Text variant="bodySm" as="p" tone="subdued">Optimization Progress</Text>
                              <ProgressBar
                                progress={product.score}
                                size="small"
                                tone={product.score >= 80 ? 'success' : product.score >= 60 ? 'attention' : 'critical'}
                              />
                            </BlockStack>

                            {product.needsOptimization && (
                              <InlineStack align="end">
                                <Button variant="primary" onClick={() => handleOptimizeProduct(product.id)} loading={isActive} disabled={isBusy || quotaReached}>
                                  {isActive ? 'Optimizing…' : 'Optimize This Product'}
                                </Button>
                              </InlineStack>
                            )}
                          </BlockStack>
                        </Box>
                      </InlineStack>
                    </Card>
                  );
                })
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
