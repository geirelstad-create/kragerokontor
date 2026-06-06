import { randomUUID } from 'node:crypto';
import { config } from './config.js';

// ---- Felles headere mot Vipps ----
function vippsHeaders(extra: Record<string, string> = {}) {
  return {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': config.VIPPS_SUBSCRIPTION_KEY ?? '',
    'Merchant-Serial-Number': config.VIPPS_MSN ?? '',
    'Vipps-System-Name': 'quad-booking',
    'Vipps-System-Version': '1.0.0',
    'Vipps-System-Plugin-Name': 'quad-booking',
    'Vipps-System-Plugin-Version': '1.0.0',
    ...extra,
  };
}

export function vippsConfigured() {
  return Boolean(
    config.VIPPS_CLIENT_ID &&
    config.VIPPS_CLIENT_SECRET &&
    config.VIPPS_SUBSCRIPTION_KEY &&
    config.VIPPS_MSN
  );
}

// ---- Access token (caches til litt før utløp) ----
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }
  const res = await fetch(`${config.VIPPS_BASE_URL}/accessToken/get`, {
    method: 'POST',
    headers: {
      'client_id': config.VIPPS_CLIENT_ID ?? '',
      'client_secret': config.VIPPS_CLIENT_SECRET ?? '',
      'Ocp-Apim-Subscription-Key': config.VIPPS_SUBSCRIPTION_KEY ?? '',
      'Merchant-Serial-Number': config.VIPPS_MSN ?? '',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vipps access token feilet: ${res.status} ${text}`);
  }
  const data: any = await res.json();
  const token = data.access_token as string;
  // expires_in er sekunder; faller tilbake til 1 time
  const expiresIn = Number(data.expires_in ?? 3600);
  cachedToken = { token, expiresAt: now + expiresIn * 1000 };
  return token;
}

// ---- Opprett betaling ----
export type CreateVippsPaymentInput = {
  reference: string;        // unik referanse (bruker booking-id)
  amountNok: number;        // beløp i hele kroner
  phoneNumber: string;      // MSISDN, f.eks. 4791234567
  description: string;
  returnUrl: string;
};

export async function createVippsPayment(input: CreateVippsPaymentInput): Promise<{ redirectUrl: string }> {
  const token = await getAccessToken();
  const body = {
    amount: { currency: 'NOK', value: Math.round(input.amountNok * 100) }, // value i øre
    paymentMethod: { type: 'WALLET' },
    customer: { phoneNumber: input.phoneNumber },
    reference: input.reference,
    returnUrl: input.returnUrl,
    userFlow: 'WEB_REDIRECT',
    paymentDescription: input.description,
  };
  const res = await fetch(`${config.VIPPS_BASE_URL}/epayment/v1/payments`, {
    method: 'POST',
    headers: vippsHeaders({
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': randomUUID(),
    }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vipps create payment feilet: ${res.status} ${text}`);
  }
  const data: any = await res.json();
  return { redirectUrl: data.redirectUrl };
}

// ---- Hent betaling (status) ----
export async function getVippsPayment(reference: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${config.VIPPS_BASE_URL}/epayment/v1/payments/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: vippsHeaders({ 'Authorization': `Bearer ${token}` }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vipps get payment feilet: ${res.status} ${text}`);
  }
  return res.json();
}

// ---- Capture (trekk beløpet) ----
export async function captureVippsPayment(reference: string, amountNok: number): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${config.VIPPS_BASE_URL}/epayment/v1/payments/${encodeURIComponent(reference)}/capture`, {
    method: 'POST',
    headers: vippsHeaders({
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': randomUUID(),
    }),
    body: JSON.stringify({ modificationAmount: { currency: 'NOK', value: Math.round(amountNok * 100) } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vipps capture feilet: ${res.status} ${text}`);
  }
}
