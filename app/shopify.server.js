import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { setDefaultResultOrder } from "node:dns";
import prisma from "./db.server";
import { BILLING_CONFIG } from "./billing.server";

// Prefer IPv4 for every outbound request in this process.
//
// This container hangs on IPv6 connect attempts (ConnectTimeoutError to
// 2620:127:f00e::), which is why optimize.server already sets this. But it set
// it LAZILY, from inside timedFetch — and timedFetch is only used for image
// downloads, never for admin.graphql. So on a freshly started container the
// first Shopify Admin API call still went out with Node's default resolution
// order. Setting it here, where every route's authenticate/graphql comes from,
// means it is in place before any request can be made.
try {
  setDefaultResultOrder("ipv4first");
} catch {
  /* older runtimes don't have it */
}

export const PLAN_BASIC = BILLING_CONFIG.planName;
export const PLAN_BASIC_ANNUAL = `${BILLING_CONFIG.planName} Annual`;

// Trial line, only included when BILLING_TRIAL_DAYS > 0.
const trial =
  BILLING_CONFIG.trialDays > 0 ? { trialDays: BILLING_CONFIG.trialDays } : {};

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [PLAN_BASIC]: {
      lineItems: [
        {
          amount: BILLING_CONFIG.amount,
          currencyCode: BILLING_CONFIG.currency,
          interval: BillingInterval.Every30Days,
        },
      ],
      ...trial,
    },
    // Yearly plan, only registered when BILLING_YEARLY_ENABLED !== "false".
    ...(BILLING_CONFIG.yearlyEnabled
      ? {
          [PLAN_BASIC_ANNUAL]: {
            lineItems: [
              {
                amount: BILLING_CONFIG.amountYearly,
                currencyCode: BILLING_CONFIG.currency,
                interval: BillingInterval.Annual,
              },
            ],
            ...trial,
          },
        }
      : {}),
  },
  future: { expiringOfflineAccessTokens: true },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
