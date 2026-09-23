import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLoaderData, useFetcher, useRevalidator } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { getUsage, getRemaining } from '../usage.server';
import { entitled } from '../plans.server';
import db from '../db.server';
import { measureSizesMB, optimizeBatch } from '../optimize.server';
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
  Spinner,
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
    // push rather than rebuild: spreading the accumulator each page re-copies
    // every product already fetched, which is quadratic on a large catalog.
    for (const edge of data.data.products.edges) allProducts.push(edge.node);
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
    // summary metafield). measureSizesMB serves these from the ImageSize cache
    // and only goes to the network for urls it has never seen, so this costs
    // thousands of HEAD requests exactly once rather than on every render.
    const measureTasks = [];
    for (const product of products) {
      if (parseSummary(product)) continue;
      for (const edge of product.images.edges) {
        measureTasks.push({ productId: product.id, url: edge.node.url });
      }
    }
    const sizeByUrl = await measureSizesMB(measureTasks.map(t => t.url));
    const measuredByProduct = {};
    for (const t of measureTasks) {
      measuredByProduct[t.productId] = (measuredByProduct[t.productId] || 0) + (sizeByUrl.get(t.url) || 0);
    }

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
      return await optimizeBatch(admin, productId, {
        shop: session.shop,
        remainingQuota,
        genAlt: entitled(plan, 'altText'),
      });
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

/**
 * How many images of the same product the browser optimizes at once.
 *
 * The server used to own this (BATCH_CONCURRENCY, 6) because it processed a
 * whole batch per request. With one image per request the browser owns it, and
 * it's kept lower: each image costs several Shopify mutations, so a wider pool
 * just trades our queue for the API's own throttle.
 */
const IMAGE_CONCURRENCY = 3;

/** Run `fn` over `items` with at most `limit` in flight. Mirrors mapLimit. */
async function mapLimitClient(items, limit, fn, shouldStop) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      // Post-increment is safe: JavaScript runs one worker at a time between
      // awaits, so no two can claim the same item.
      let index = cursor++;
      while (index < items.length) {
        if (shouldStop()) return;
        await fn(items[index], index);
        index = cursor++;
      }
    }
  );
  await Promise.all(workers);
}

const formatBytes = (mb) => {
  const v = mb || 0;
  if (v >= 1000) return `${(v / 1000).toFixed(1)} GB`;
  if (v >= 1) return `${v.toFixed(1)} MB`;
  if (v > 0) return `${Math.max(1, Math.round(v * 1024))} KB`;
  return `0 KB`;
};

export default function ProductOptimization() {
  const {
    products, filter: initialFilter, sortBy: initialSortBy, stats, error: loadError,
    plan, usage, autoOptimize: initialAutoOptimize,
  } = useLoaderData();
  // Optimization no longer goes through a fetcher — it drives /api/optimize
  // directly so several images can be in flight at once.
  const settingsFetcher = useFetcher();
  const revalidator = useRevalidator();

  const [filter, setFilter] = useState(initialFilter);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [error, setError] = useState(loadError);
  const [successMessage, setSuccessMessage] = useState(null);
  const [autoOptimize, setAutoOptimize] = useState(initialAutoOptimize);

  // Live per-product progress, keyed by product id, updated after every IMAGE.
  const [liveProgress, setLiveProgress] = useState({});

  // Track images optimized this session so the usage meter moves without a reload.
  const [sessionImages, setSessionImages] = useState(0);

  /**
   * A run, driven one IMAGE per request from the browser.
   *
   * It used to be one request per BATCH of up to BATCH_SIZE (10) images, which
   * meant a product with fewer images than that was a single request: the card
   * jumped from 0/8 to 8/8 with nothing in between. Asking for one image at a
   * time makes every response a progress event, and the pool below keeps the
   * parallelism that made batching fast in the first place.
   *
   * Counters live in a ref and are published into state — several concurrent
   * workers updating the same tallies through setState callbacks is much easier
   * to get wrong.
   */
  const [run, setRun] = useState(null);
  const runRef = useRef(null);
  // Set by the Stop button and by a quota refusal; every worker checks it.
  const stopRef = useRef(false);

  const publish = useCallback(() => {
    const s = runRef.current;
    setRun(s ? { ...s, images: s.images.map(i => ({ ...i })) } : null);
  }, []);

  /** One call to the per-image API. */
  const callApi = useCallback(async (fields) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);

    // App Bridge already adds the session token to relative fetches, but asking
    // for it explicitly means auth doesn't depend on that patch being in place.
    const headers = {};
    try {
      const token = await window.shopify?.idToken?.();
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch { /* App Bridge's own fetch patch is the backstop */ }

    const response = await fetch('/api/optimize', { method: 'POST', body, headers });

    let data = null;
    try { data = await response.json(); } catch { /* fall through */ }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Your session expired. Reload the page and try again.');
      }
      throw new Error(data?.error || `The server returned an error (${response.status}).`);
    }
    if (!data) throw new Error('The server sent back an empty response.');
    return data;
  }, []);

  const executeRun = useCallback(async (productIds) => {
    const byId = new Map(products.map(p => [p.id, p]));

    runRef.current = {
      productIds,
      productIndex: 0,
      productTitle: byId.get(productIds[0])?.title || '',
      // Seeded from the counts already on screen so the bar is honest from the
      // first frame, then corrected with the real count per product.
      totalImages: productIds.reduce((sum, id) => sum + (byId.get(id)?.imageCount || 0), 0),
      imagesDone: 0,
      imagesOptimized: 0,
      imagesSkipped: 0,
      imagesFailed: 0,
      savedMB: 0,
      images: [],
      recent: [],
      stopping: false,
    };
    publish();

    let quotaError = null;
    let lastError = null;

    for (let i = 0; i < productIds.length; i++) {
      if (stopRef.current) break;

      const productId = productIds[i];
      const state = runRef.current;
      state.productIndex = i;
      state.productTitle = byId.get(productId)?.title || '';
      state.images = [];
      publish();

      let listing;
      try {
        listing = await callApi({ intent: 'listImages', productId });
      } catch (err) {
        lastError = err.message;
        // Drop the estimate, or its images sit in the total forever and the bar
        // can never reach 100%.
        state.totalImages -= byId.get(productId)?.imageCount || 0;
        publish();
        continue;
      }

      state.totalImages += listing.images.length - (byId.get(productId)?.imageCount || 0);
      state.productTitle = listing.title;
      state.images = listing.images.map(img => ({
        id: img.id,
        url: img.url,
        // Images already recorded are shown as done immediately rather than
        // re-sent — that resumability is what the batch path gave us for free.
        status: img.done ? 'skipped' : 'pending',
        detail: img.done ? 'Done earlier' : null,
      }));
      publish();

      // The id each slot ends up holding, so the merchant's order can be put
      // back: replacing an image appends the copy at the end, and with several
      // in flight they no longer finish in the order they started.
      const finalIds = listing.images.map(img => img.id);
      const todo = listing.images
        .map((img, index) => ({ ...img, index }))
        .filter(img => !img.done);

      // Per-product accumulators, so each card's numbers move image by image.
      let productOptimized = listing.images.length - todo.length;
      let productSaved = 0;
      const productTotal = listing.images.length;
      const pushProductProgress = () => {
        const base = byId.get(productId);
        setLiveProgress(prev => ({
          ...prev,
          [productId]: {
            ...prev[productId],
            optimized: productOptimized,
            score: productTotal > 0 ? Math.round((productOptimized / productTotal) * 100) : 0,
            sizeSavedMB: (base?.sizeSavedMB || 0) + productSaved,
            // view() reads these straight into the card, so they must always be
            // numbers. The authoritative values arrive from finalize; until then
            // the loader's own figures stand in.
            originalSizeMB: base?.totalOriginalSizeMB || 0,
            compressionRate: base?.compressionRate || 0,
          },
        }));
      };
      pushProductProgress();

      await mapLimitClient(
        todo,
        IMAGE_CONCURRENCY,
        async (image) => {
          const entry = runRef.current.images[image.index];
          entry.status = 'working';
          publish();

          let result;
          try {
            result = await callApi({ intent: 'optimizeImage', productId, imageId: image.id });
          } catch (err) {
            result = { success: false, error: err.message };
          }

          const live = runRef.current;

          // Every remaining image would return the same refusal, so stop.
          if (result.quotaExceeded) {
            quotaError = 'Monthly image quota reached. Upgrade your plan to optimize more images this month.';
            stopRef.current = true;
            entry.status = 'pending';
            publish();
            return;
          }

          if (result.success) {
            finalIds[image.index] = result.newImageId || image.id;
            live.imagesDone += 1;
            productOptimized += 1;

            if (result.skipped) {
              live.imagesSkipped += 1;
              entry.status = 'skipped';
              entry.detail = 'Already optimal';
            } else {
              live.imagesOptimized += 1;
              live.savedMB += result.savedMB || 0;
              productSaved += result.savedMB || 0;
              entry.status = 'done';
              entry.detail = `−${result.compressionRate}%`;
              live.recent = [{
                key: result.newImageId,
                text: `${listing.title} — ${formatBytes(result.originalSizeMB)} → ${formatBytes(result.optimizedSizeMB)} (−${result.compressionRate}%)`,
              }, ...live.recent].slice(0, 4);
              // Only re-encoded images are metered, so only they move the meter.
              setSessionImages(s => s + 1);
            }
          } else {
            live.imagesFailed += 1;
            lastError = result.error;
            entry.status = 'failed';
            entry.detail = result.error;
          }

          pushProductProgress();
          publish();
        },
        () => stopRef.current
      );

      // Rewrite the summary and restore the order, even for a partial product —
      // the stored numbers should describe what is on the store now.
      try {
        const { summary } = await callApi({
          intent: 'finalize',
          productId,
          order: JSON.stringify(finalIds),
        });
        if (summary) {
          setLiveProgress(prev => ({
            ...prev,
            [productId]: {
              optimized: summary.processed,
              score: summary.totalImages > 0
                ? Math.round((summary.processed / summary.totalImages) * 100)
                : 0,
              originalSizeMB: summary.totalOriginalSizeMB,
              sizeSavedMB: summary.totalSizeSavedMB,
              compressionRate: summary.avgCompressionRate,
              needsOptimization: summary.processed < summary.totalImages,
            },
          }));
        }
      } catch (err) {
        console.error('Could not finalize', productId, err);
      }
    }

    const final = runRef.current;
    const stoppedByUser = final.stopping;

    runRef.current = null;
    stopRef.current = false;
    setRun(null);

    if (final.imagesDone === 0 && final.imagesFailed === 0) {
      if (stoppedByUser && !quotaError) {
        setSuccessMessage('Stopped — nothing was changed.');
        setTimeout(() => setSuccessMessage(null), 6000);
      } else {
        setError(quotaError || lastError || 'Nothing was optimized.');
      }
    } else if (final.imagesDone === 0) {
      setError(lastError || 'None of the images could be optimized.');
    } else {
      const parts = [];
      if (final.imagesOptimized > 0) {
        parts.push(`Optimized ${final.imagesOptimized} image${final.imagesOptimized > 1 ? 's' : ''} — saved ${formatBytes(final.savedMB)}.`);
      }
      if (final.imagesSkipped > 0) {
        parts.push(`${final.imagesSkipped} image${final.imagesSkipped > 1 ? 's were' : ' was'} already as small as possible.`);
      }
      if (final.imagesFailed > 0) parts.push(`${final.imagesFailed} could not be processed — ${lastError}`);
      if (quotaError) parts.push(quotaError);
      else if (stoppedByUser) parts.push('You stopped the run; the rest were left alone.');

      setSuccessMessage(parts.join(' '));
      setTimeout(() => setSuccessMessage(null), 12000);
    }

    // Quietly re-run the loader in place. liveProgress stays authoritative for
    // display, so read-after-write metafield lag can't flip a finished product
    // back to "needs optimization".
    revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, callApi, publish, revalidator]);

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
    if (!ids.length || runRef.current) return;
    setError(null);
    setSuccessMessage(null);
    stopRef.current = false;
    executeRun(ids).catch((err) => {
      // A throw here would leave the page showing progress forever.
      console.error('Optimization run crashed:', err);
      runRef.current = null;
      stopRef.current = false;
      setRun(null);
      setError(err.message || 'The optimization run stopped unexpectedly.');
      revalidator.revalidate();
    });
  }, [executeRun, revalidator]);

  const handleStopRun = useCallback(() => {
    stopRef.current = true;
    if (runRef.current) {
      runRef.current.stopping = true;
      publish();
    }
  }, [publish]);

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

  const isRunning = run !== null;
  const isBusy = isRunning || revalidator.state !== 'idle';
  const activeId = run ? run.productIds[run.productIndex] : null;

  const imagesSettled = run ? run.imagesDone + run.imagesFailed : 0;
  const progress = run && run.totalImages > 0
    ? Math.min(100, Math.round((imagesSettled / run.totalImages) * 100))
    : 0;
  const productImagesSettled = run
    ? run.images.filter(i => i.status !== 'pending' && i.status !== 'working').length
    : 0;

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
      title="PixelPerfect — Image Optimizer"
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

        {isRunning && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap={true}>
                  <InlineStack gap="300" blockAlign="center">
                    <Spinner accessibilityLabel="Optimization in progress" size="small" />
                    <Text variant="headingMd" as="h3">
                      {run.stopping
                        ? 'Finishing the images already started…'
                        : run.images.length > 0
                          ? `Optimizing image ${Math.min(productImagesSettled + 1, run.images.length)} of ${run.images.length}…`
                          : 'Reading the product’s images…'}
                    </Text>
                  </InlineStack>
                  <InlineStack gap="300" blockAlign="center">
                    <Text variant="headingMd" as="p" tone="subdued">{`${progress}%`}</Text>
                    {!run.stopping && (
                      <Button variant="tertiary" onClick={handleStopRun}>Stop</Button>
                    )}
                  </InlineStack>
                </InlineStack>

                <ProgressBar progress={progress} size="small" tone="primary" />

                <Text variant="bodyMd" as="p">
                  {run.productTitle
                    ? <Text as="span" fontWeight="semibold">{run.productTitle}</Text>
                    : 'Starting…'}
                  {run.productIds.length > 1 &&
                    ` — product ${run.productIndex + 1} of ${run.productIds.length}`}
                </Text>

                {/* One tile per image, so "how many are done" is something the
                    merchant can see rather than infer from a spinner. */}
                {run.images.length > 0 && (
                  <InlineStack gap="200" wrap={true}>
                    {run.images.map((image, index) => (
                      <BlockStack key={image.id} gap="100" inlineAlign="center">
                        <Box
                          borderWidth="050"
                          borderRadius="200"
                          padding="050"
                          borderColor={
                            image.status === 'done' ? 'border-success'
                              : image.status === 'failed' ? 'border-critical'
                                : image.status === 'working' ? 'border-emphasis'
                                  : 'border'
                          }
                        >
                          <Thumbnail source={image.url} alt={`Image ${index + 1}`} size="small" />
                        </Box>
                        {image.status === 'working' ? (
                          <Spinner accessibilityLabel={`Optimizing image ${index + 1}`} size="small" />
                        ) : (
                          <Text variant="bodySm" as="span" tone={
                            image.status === 'done' ? 'success'
                              : image.status === 'failed' ? 'critical'
                                : 'subdued'
                          }>
                            {image.status === 'done' ? image.detail
                              : image.status === 'skipped' ? 'Optimal'
                                : image.status === 'failed' ? 'Failed'
                                  : `#${index + 1}`}
                          </Text>
                        )}
                      </BlockStack>
                    ))}
                  </InlineStack>
                )}

                <Text variant="bodySm" as="p" tone="subdued">
                  {`${imagesSettled} of ${run.totalImages} image${run.totalImages === 1 ? '' : 's'} done`}
                  {run.imagesOptimized > 0 && ` · ${formatBytes(run.savedMB)} saved`}
                  {run.imagesSkipped > 0 && ` · ${run.imagesSkipped} already optimal`}
                  {run.imagesFailed > 0 && ` · ${run.imagesFailed} failed`}
                </Text>

                {run.recent.length > 0 && (
                  <BlockStack gap="100">
                    {run.recent.map((entry) => (
                      <Text key={entry.key} variant="bodySm" as="p" tone="subdued">
                        {`✓ ${entry.text}`}
                      </Text>
                    ))}
                  </BlockStack>
                )}

                <Text variant="bodySm" as="p" tone="subdued">
                  {`Up to ${IMAGE_CONCURRENCY} images are processed at a time. Each one is downloaded, re-compressed and uploaded back to Shopify, so please keep this page open.`}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

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
