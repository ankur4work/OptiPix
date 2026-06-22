import { redirect, useSubmit, useNavigation, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getBillingState,
  managedPricingUrl,
  appBridgeRedirect,
} from "../billing.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import PricingTiers from "../components/PricingTiers";

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    const { hasActivePlan } = await getBillingState(admin);
    if (hasActivePlan) throw redirect("/app");
  } catch (e) {
    if (e instanceof Response) throw e;
    // auth or billing error — stay on pricing page
  }
  return null;
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { appHandle } = await getBillingState(admin);
  throw appBridgeRedirect(managedPricingUrl(session.shop, appHandle));
};

export default function PricingPage() {
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";

  const handleSubscribe = () => submit({}, { method: "post" });

  return <PricingTiers onSubscribe={handleSubscribe} isLoading={isLoading} />;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
